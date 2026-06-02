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
  const proxy = createProxyServer(am, {
    upstream: `http://127.0.0.1:${upstreamPort}`,
    proxy: { apiKey: 'test' },
  });
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
