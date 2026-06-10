import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

// Fake Anthropic upstream: streams an SSE message with cache usage + a unified
// rate-limit header, echoing which credential it received.
function makeUpstream(seenAuth) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seenAuth.push(req.headers['authorization'] || req.headers['x-api-key'] || null);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'anthropic-ratelimit-unified-5h-utilization': '0.10',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
      });
      res.write('event: message_start\ndata: ' + JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 1234 } },
      }) + '\n\n');
      res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 7 } }) + '\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    });
  });
}

// A real Claude Code turn resends the whole history, so messages[0] (the first
// user turn) stays fixed while later turns are appended — that is what keeps the
// session key stable. `extra` simulates the growing tail.
function chatBody(extra = []) {
  return JSON.stringify({
    model: 'claude-x',
    system: 'sys',
    tools: [{ name: 'Read' }],
    messages: [{ role: 'user', content: 'first turn of conversation one' }, ...extra],
  });
}

test('end-to-end: proxy forwards, captures cache usage, and pins a session', async () => {
  const seenAuth = [];
  const upstream = makeUpstream(seenAuth);
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'key-a' },
    { name: 'b', type: 'apikey', apiKey: 'key-b' },
  ], 0.98);
  const ends = [];
  const proxy = createProxyServer(am, {
    upstream: `http://127.0.0.1:${upstreamPort}`,
    proxy: { apiKey: 'test' },
  }, { onRequestEnd: (id, info) => ends.push(info) });
  const proxyPort = await listen(proxy);
  const url = `http://127.0.0.1:${proxyPort}/v1/messages`;
  const post = (extra) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: chatBody(extra),
  }).then(async r => ({ status: r.status, text: await r.text() }));

  try {
    const r1 = await post();
    assert.equal(r1.status, 200);
    assert.ok(r1.text.includes('message_start'), 'SSE body streamed through');

    // The onRequestEnd hook carries the per-request usage breakdown.
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0].usage, { input: 5, output: 7, cacheCreation: 0, cacheRead: 1234 });

    const served = am.accounts.find(a => a.usage.totalRequests > 0);
    assert.ok(served, 'a request was attributed to an account');
    assert.equal(served.usage.totalCacheReadTokens, 1234, 'cache_read captured (Layer 0)');
    assert.equal(served.usage.totalOutputTokens, 7, 'output tokens captured');
    assert.equal(served.usage.totalSwitchRebuilds, 0, 'warm read is not counted as a cold rebuild');

    // Same conversation, next turn (history grows) -> must stay pinned (affinity).
    await post([
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second turn, longer now ' + 'x'.repeat(100) },
    ]);
    const others = am.accounts.filter(a => a !== served && a.usage.totalRequests > 0);
    assert.equal(others.length, 0, 'session stayed pinned; no other account was used');
    assert.equal(served.usage.totalRequests, 2);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

// Stateful upstream for probe tests: 429s the first `failFirst` requests, then
// 200s (simulates a rolling-window account recovering). Optional `delayMs` keeps
// a probe in-flight long enough to test concurrency/timeout. Counts every hit.
function makeRecoveringUpstream({ failFirst = 0, delayMs = 0, util = 0.20 } = {}) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      hits++;
      const serve200 = hits > failFirst;
      const respond = () => {
        if (!serve200) {
          res.writeHead(429, {
            'content-type': 'application/json',
            'retry-after': '3600',
            'anthropic-ratelimit-unified-5h-utilization': '0.999',
            'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 120),
          });
          res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'exhausted' } }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'anthropic-ratelimit-unified-5h-utilization': String(util),
          'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
        });
        res.write('event: message_start\ndata: ' + JSON.stringify({
          type: 'message_start',
          message: { usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 1234 } },
        }) + '\n\n');
        res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 7 } }) + '\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
      };
      if (delayMs) setTimeout(respond, delayMs); else respond();
    });
  });
  server.hits = () => hits;
  return server;
}

// Drive both accounts into a "looks exhausted, reset in the future" state so
// getActiveAccount returns null — the precondition for the probe path.
function exhaustBoth(am) {
  for (const a of am.accounts) {
    a.quota.unified5h = 0.999;
    a.quota.unified5hReset = Date.now() + 3600e3;
    a.quota.unifiedStatus = 'rejected';
  }
}

test('probe serves the turn when an exhausted account has recovered early (rolling window)', async () => {
  const upstream = makeRecoveringUpstream(); // always 200 — the account has recovered
  const uPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'ka' },
    { name: 'b', type: 'apikey', apiKey: 'kb' },
  ], 0.98);
  exhaustBoth(am);
  assert.equal(am.getActiveAccount(), null, 'precondition: nothing routable from cached quota');

  const ends = [];
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${uPort}`, proxy: { apiKey: 'test' } },
    { onRequestEnd: (id, info) => ends.push(info) });
  const pPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${pPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody(),
    });
    const text = await res.text();
    assert.equal(res.status, 200, 'probe discovered recovery and served the turn — no manual resend');
    assert.ok(text.includes('message_start'), 'SSE body streamed through the probe path');
    assert.equal(upstream.hits(), 1, 'exactly one upstream probe');

    const served = am.accounts.find(a => a.usage.totalRequests > 0);
    assert.ok(served, 'usage attributed to the probed account');
    assert.equal(served.usage.totalCacheReadTokens, 1234, 'cache usage captured on the probe path');
    assert.equal(ends[0].usage.output, 7, 'per-request usage captured for the probe');
    assert.notEqual(served.quota.unifiedStatus, 'rejected', 'recovered account reactivated');
    assert.ok(am.getActiveAccount(), 'normal routing resumes after recovery (no more probing needed)');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('a recovered account still reporting high utilization stays routable (no re-probe 429)', async () => {
  // A rolling 5h window can serve a 200 while STILL reporting near-ceiling
  // utilization. markRecovered must relax the cached util, or the next request
  // re-trips _mustSwitch, hits the probe throttle, and 429s a working account.
  const upstream = makeRecoveringUpstream({ util: 0.999 });
  const uPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'ka' },
    { name: 'b', type: 'apikey', apiKey: 'kb' },
  ], 0.98);
  exhaustBoth(am);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${uPort}`, proxy: { apiKey: 'test' } });
  const pPort = await listen(proxy);
  const post = () => fetch(`http://127.0.0.1:${pPort}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody(),
  }).then(async r => { await r.text(); return r.status; });
  try {
    assert.equal(await post(), 200, 'probe discovers and serves the recovered account');
    // Second request is WITHIN the 30s probe-throttle window: without the
    // markRecovered util-relax it would route to null, hit the throttle, and
    // 429 — even though the account just answered 200. It must be served.
    assert.equal(await post(), 200, 'high-util-but-recovered account routes normally — no spurious 429');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('probe that comes back 429 falls through to a prompt, capped 429', async () => {
  const upstream = makeRecoveringUpstream({ failFirst: Infinity }); // never recovers
  const uPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'ka' },
    { name: 'b', type: 'apikey', apiKey: 'kb' },
  ], 0.98);
  exhaustBoth(am);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${uPort}`, proxy: { apiKey: 'test' } });
  const pPort = await listen(proxy);
  try {
    const start = Date.now();
    const res = await fetch(`http://127.0.0.1:${pPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody(),
    });
    const text = await res.text();
    const elapsed = Date.now() - start;
    assert.equal(res.status, 429, 'genuine exhaustion still 429s the client');
    assert.ok(elapsed < 5000, `returns promptly on a failed sweep (${elapsed}ms)`);
    assert.equal(upstream.hits(), 2, 'sweep tried both accounts once, then gave up — no hammering');
    assert.ok(Number(res.headers.get('retry-after')) <= 55, 'retry-after capped');
    assert.ok(/usage limit/.test(JSON.parse(text).error.message));
    assert.equal(am._probeInFlight, false, 'probe slot released');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

// Upstream that serves 200 ONLY for the account whose credential matches
// `recoveredKey`; every other account gets a quota 429. Lets a test put recovery
// on a *specific* account regardless of probe order.
function makeSelectiveUpstream(recoveredKey) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      hits++;
      if (req.headers['x-api-key'] === recoveredKey) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'anthropic-ratelimit-unified-5h-utilization': '0.30',
          'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
        });
        res.write('event: message_start\ndata: ' + JSON.stringify({
          type: 'message_start',
          message: { usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 1234 } },
        }) + '\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
        return;
      }
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '3600',
        'anthropic-ratelimit-unified-5h-utilization': '0.999',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 120),
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'exhausted' } }));
    });
  });
  server.hits = () => hits;
  return server;
}

test('sweep finds recovery on a LATER-resetting account, not just the soonest (case B)', async () => {
  // Account a resets SOONER but is still exhausted; account b resets LATER but
  // has already rolled over. The old single-candidate probe only tried a and
  // never discovered b, so the user stayed blocked. The sweep must serve b.
  const upstream = makeSelectiveUpstream('kb'); // only account b (key kb) has recovered
  const uPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'ka' },
    { name: 'b', type: 'apikey', apiKey: 'kb' },
  ], 0.98);
  const A = am.accounts[0], B = am.accounts[1];
  A.quota.unified5h = 0.999; A.quota.unified5hReset = Date.now() + 60e3;  A.quota.unifiedStatus = 'rejected'; // sooner
  B.quota.unified5h = 0.999; B.quota.unified5hReset = Date.now() + 600e3; B.quota.unifiedStatus = 'rejected'; // later
  assert.equal(am.getActiveAccount(), null, 'precondition: nothing routable from cached quota');
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${uPort}`, proxy: { apiKey: 'test' } });
  const pPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${pPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody(),
    });
    const text = await res.text();
    assert.equal(res.status, 200, 'sweep probed a (429) then b (200) and served b — the bug the user hit');
    assert.ok(text.includes('message_start'), 'b\'s response streamed to the client');
    assert.equal(B.usage.totalCacheReadTokens, 1234, 'the recovered later-reset account b actually served it');
    assert.equal(upstream.hits(), 2, 'both accounts were swept (a rejected, b served)');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('two concurrent requests under full exhaustion launch exactly one probe', async () => {
  const upstream = makeRecoveringUpstream({ delayMs: 150 }); // 200, but slow enough to stay in-flight
  const uPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'ka' },
    { name: 'b', type: 'apikey', apiKey: 'kb' },
  ], 0.98);
  exhaustBoth(am);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${uPort}`, proxy: { apiKey: 'test' } });
  const pPort = await listen(proxy);
  const post = () => fetch(`http://127.0.0.1:${pPort}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody(),
  }).then(r => r.status);
  try {
    const [s1, s2] = await Promise.all([post(), post()]);
    assert.equal(upstream.hits(), 1, 'in-flight guard + throttle ⇒ exactly one upstream probe');
    const statuses = [s1, s2].sort();
    assert.deepEqual(statuses, [200, 429], 'one request served by the probe, the other 429s');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('a second request within the throttle window does not re-probe', async () => {
  const upstream = makeRecoveringUpstream({ failFirst: Infinity });
  const uPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'ka' },
    { name: 'b', type: 'apikey', apiKey: 'kb' },
  ], 0.98);
  exhaustBoth(am);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${uPort}`, proxy: { apiKey: 'test' } });
  const pPort = await listen(proxy);
  const post = () => fetch(`http://127.0.0.1:${pPort}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody(),
  }).then(async r => { await r.text(); return r.status; });
  try {
    assert.equal(await post(), 429);
    assert.equal(upstream.hits(), 2, 'first request sweeps both accounts once');
    assert.equal(await post(), 429);
    assert.equal(upstream.hits(), 2, 'second request inside the throttle window sends no new probe');
    am._lastProbeAt = Date.now() - 16000; // 15s window elapses
    assert.equal(await post(), 429);
    assert.equal(upstream.hits(), 4, 'after the window a fresh sweep fires (both accounts again)');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('a hung probe is aborted and the client gets a prompt 429', async () => {
  const upstream = makeRecoveringUpstream({ delayMs: 500 }); // slower than the probe timeout
  const uPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'ka' },
    { name: 'b', type: 'apikey', apiKey: 'kb' },
  ], 0.98);
  am._probeTimeoutMs = 150; // abort well before the upstream answers
  exhaustBoth(am);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${uPort}`, proxy: { apiKey: 'test' } });
  const pPort = await listen(proxy);
  try {
    const start = Date.now();
    const res = await fetch(`http://127.0.0.1:${pPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody(),
    });
    await res.text();
    const elapsed = Date.now() - start;
    assert.equal(res.status, 429, 'aborted probe falls through to the 429');
    assert.ok(elapsed < 2000, `not pinned open by the hung upstream (${elapsed}ms)`);
    assert.equal(am._probeInFlight, false, 'probe slot released after the abort');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

// Upstream that always rejects with a quota-exhaustion 429 and a long retry-after.
function make429Upstream() {
  return http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '3600', // an hour — the proxy must NOT hold the request this long
        'anthropic-ratelimit-unified-5h-utilization': '0.999',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 120),
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'exhausted' } }));
    });
  });
}

test('all accounts quota-exhausted returns 429 promptly (no endless hang)', async () => {
  const upstream = make429Upstream();
  const uPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'ka' },
    { name: 'b', type: 'apikey', apiKey: 'kb' },
  ], 0.98);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${uPort}`, proxy: { apiKey: 'test' } });
  const pPort = await listen(proxy);
  try {
    const start = Date.now();
    const res = await fetch(`http://127.0.0.1:${pPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody(),
    });
    const elapsed = Date.now() - start;
    const text = await res.text();
    assert.equal(res.status, 429);
    assert.ok(elapsed < 5000, `returned promptly, not held open (${elapsed}ms)`);
    const ra = Number(res.headers.get('retry-after'));
    assert.ok(ra > 0 && ra <= 55, `retry-after capped below the SDK's 60s honor threshold, got ${ra}`);
    // The message no longer prints a misleading raw seconds countdown.
    const msg = JSON.parse(text).error.message;
    assert.ok(/usage limit/.test(msg) && /resend/.test(msg), `honest message, got: ${msg}`);
    assert.ok(!/Retry in \d+s/.test(msg), 'no misleading raw seconds in the message');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
