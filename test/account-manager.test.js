import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { deriveSessionKey, computeRetryAfter } from '../src/server.js';

function makeManager(names = ['a', 'b', 'c'], threshold = 0.98) {
  return new AccountManager(
    names.map((n, i) => ({ name: n, type: 'apikey', apiKey: `key-${i}` })),
    threshold,
  );
}

// Drive an account past the HARD ceiling so it must be switched off immediately
// (Layer 2: 0.98 only arms; 0.995+ / 'rejected' forces the switch).
function exhaust(am, name) {
  const a = am.accounts.find(x => x.name === name);
  a.quota.unified5h = 0.999;
}
function reset(am, name) {
  const a = am.accounts.find(x => x.name === name);
  a.quota.unified5h = null;
  a.quota.unified5hReset = null;
}
function setUtil(am, name, u) {
  am.accounts.find(x => x.name === name).quota.unified5h = u;
}

test('session affinity: same key sticks to one account', () => {
  const am = makeManager();
  const first = am.getActiveAccount('s1');
  assert.equal(am.getActiveAccount('s1').name, first.name);
  assert.equal(am.getActiveAccount('s1').name, first.name);
});

test('forced switch is forward-only and the old account is never re-selected', () => {
  const am = makeManager();
  const a = am.getActiveAccount('s1');           // pins lowest-util -> 'a'
  assert.equal(a.name, 'a');

  exhaust(am, 'a');
  const b = am.getActiveAccount('s1');           // burn 'a', switch forward
  assert.notEqual(b.name, 'a');

  // 'a' resets and is now the freshest account again...
  reset(am, 'a');
  // ...but the session must NOT switch back to it (its cache is cold).
  assert.equal(am.getActiveAccount('s1').name, b.name);
});

test('concurrent sessions do not flip each other (per-session pins)', () => {
  const am = makeManager();
  setUtil(am, 'a', 0.1);
  setUtil(am, 'b', 0.2);
  setUtil(am, 'c', 0.3);

  assert.equal(am.getActiveAccount('s1').name, 'a'); // argmin
  assert.equal(am.getActiveAccount('s2').name, 'a'); // sharing 'a' is fine

  exhaust(am, 'a');
  assert.equal(am.getActiveAccount('s1').name, 'b'); // both move forward
  assert.equal(am.getActiveAccount('s2').name, 'b');

  setUtil(am, 'b', 0.5); // 'b' mid-usage but still serviceable
  // interleaving s2 must not move s1's pin
  assert.equal(am.getActiveAccount('s2').name, 'b');
  assert.equal(am.getActiveAccount('s1').name, 'b');
});

test('forced switch picks the lowest-utilization account, not round-robin', () => {
  const am = makeManager(['a', 'b', 'c']);
  setUtil(am, 'a', 0.999); // current, hard-limited
  setUtil(am, 'b', 0.80);
  setUtil(am, 'c', 0.10); // most headroom
  am.sessions.set('s1', { pinned: 'a', burned: new Set(), lastSeen: Date.now(), ctxPeak: null });
  assert.equal(am.getActiveAccount('s1').name, 'c');
});

test('all-burned fallback: returns null when truly exhausted, recovers after reset', () => {
  const am = makeManager(['x', 'y']);
  assert.equal(am.getActiveAccount('s').name, 'x');
  exhaust(am, 'x');
  assert.equal(am.getActiveAccount('s').name, 'y'); // burn x
  exhaust(am, 'y');
  assert.equal(am.getActiveAccount('s'), null);     // all burned + exhausted

  reset(am, 'x'); // x's window resets
  assert.equal(am.getActiveAccount('s').name, 'x'); // cleared burn set, recovers
});

test('legacy path (no session key) still routes', () => {
  const am = makeManager();
  assert.equal(am.getActiveAccount().name, 'a');
  exhaust(am, 'a');
  assert.notEqual(am.getActiveAccount().name, 'a');
});

test('cache-token accounting and cold-rebuild detection', () => {
  const am = makeManager();
  // cold rebuild: large creation, little read
  am.updateUsage(0, 100, 50, 2000, 100);
  let u = am.accounts[0].usage;
  assert.equal(u.totalCacheCreationTokens, 2000);
  assert.equal(u.totalCacheReadTokens, 100);
  assert.equal(u.lastCacheReadTokens, 100);
  assert.equal(u.totalSwitchRebuilds, 1);

  // warm read: no creation -> not counted as a rebuild
  am.updateUsage(0, 100, 50, 0, 5000);
  u = am.accounts[0].usage;
  assert.equal(u.totalCacheReadTokens, 5100);
  assert.equal(u.totalSwitchRebuilds, 1);
  assert.equal(u.lastCacheReadTokens, 5000);
});

test('session map evicts idle entries past TTL', () => {
  const am = makeManager();
  am.getActiveAccount('old');
  // backdate it beyond the TTL, then touch a new session to trigger eviction
  am.sessions.get('old').lastSeen = Date.now() - am._sessionTtlMs - 1000;
  am.getActiveAccount('fresh');
  assert.equal(am.sessions.has('old'), false);
  assert.equal(am.sessions.has('fresh'), true);
});

// ── Layer 2: compaction-aware lazy switching ──────────────────

test('warning zone defers: stays on the warm account while context stays large', () => {
  const am = makeManager(['a', 'b']);
  setUtil(am, 'a', 0.985); // armed (>=0.98) but below the 0.995 hard ceiling
  setUtil(am, 'b', 0.0);   // a much fresher account is available
  am.sessions.set('s', { pinned: 'a', burned: new Set(), lastSeen: Date.now(), ctxPeak: null });

  // Large, non-shrinking context (incl. a "yes"-style tiny reply that does not
  // shrink the resent full history): must NOT switch despite a fresher account.
  assert.equal(am.getActiveAccount('s', 200000).name, 'a');
  assert.equal(am.getActiveAccount('s', 210000).name, 'a');
  assert.equal(am.getActiveAccount('s', 200100).name, 'a');
});

test('compaction trough switches early to shrink the rebuild', () => {
  const am = makeManager(['a', 'b']);
  setUtil(am, 'a', 0.985);
  setUtil(am, 'b', 0.0);
  am.sessions.set('s', { pinned: 'a', burned: new Set(), lastSeen: Date.now(), ctxPeak: null });

  assert.equal(am.getActiveAccount('s', 200000).name, 'a'); // sets the peak
  // Client auto-compacts: body collapses well below half the peak -> switch now.
  assert.equal(am.getActiveAccount('s', 30000).name, 'b');
});

test('trough does not switch when there is no meaningfully fresher account', () => {
  const am = makeManager(['a', 'b']);
  setUtil(am, 'a', 0.985);
  setUtil(am, 'b', 0.98); // also armed — not worth a rebuild to move here
  am.sessions.set('s', { pinned: 'a', burned: new Set(), lastSeen: Date.now(), ctxPeak: null });
  am.getActiveAccount('s', 200000);
  assert.equal(am.getActiveAccount('s', 30000).name, 'a'); // stays put, rides to hard ceiling
});

test('hard ceiling overrides deferral regardless of context', () => {
  const am = makeManager(['a', 'b']);
  setUtil(am, 'a', 0.999); // hard-limited
  setUtil(am, 'b', 0.0);
  am.sessions.set('s', { pinned: 'a', burned: new Set(), lastSeen: Date.now(), ctxPeak: 200000 });
  assert.equal(am.getActiveAccount('s', 200000).name, 'b'); // big stable context, still switches
});

test("'rejected' status forces a switch even below the utilization ceiling", () => {
  const am = makeManager(['a', 'b']);
  am.accounts.find(x => x.name === 'a').quota.unifiedStatus = 'rejected';
  am.sessions.set('s', { pinned: 'a', burned: new Set(), lastSeen: Date.now(), ctxPeak: 200000 });
  assert.equal(am.getActiveAccount('s', 200000).name, 'b');
});

test('isQuotaRejection distinguishes quota exhaustion from a transient 429', () => {
  const am = makeManager(['a']);
  setUtil(am, 'a', 0.5);
  assert.equal(am.isQuotaRejection(0), false);  // transient burst -> wait
  setUtil(am, 'a', 0.98);
  assert.equal(am.isQuotaRejection(0), true);   // armed -> treat as exhaustion
  setUtil(am, 'a', 0.999);
  assert.equal(am.isQuotaRejection(0), true);
  setUtil(am, 'a', 0.1);
  am.accounts[0].quota.unifiedStatus = 'rejected';
  assert.equal(am.isQuotaRejection(0), true);
});

// ── warm-primary routing + 5h/7d selection ordering ───────────

test('a new session prefers the warm primary, not the freshest account', () => {
  const am = makeManager(['a', 'b']);
  setUtil(am, 'a', 0.5); // current primary (currentIndex 0), warm
  setUtil(am, 'b', 0.0); // fresher but cold
  assert.equal(am.getActiveAccount('news', 1000).name, 'a');
});

test('_selectBest ranks by 5h, breaking ties on weekly (7d)', () => {
  const am = makeManager(['a', 'b', 'c']);
  const set = (n, u5, u7) => {
    const x = am.accounts.find(a => a.name === n);
    x.quota.unified5h = u5; x.quota.unified7d = u7;
  };
  set('a', 0.5, 0.8); set('b', 0.5, 0.2); set('c', 0.5, 0.5);
  assert.equal(am._selectBest().name, 'b', 'equal 5h -> most weekly remaining (lowest 7d)');

  set('a', 0.3, 0.9); set('b', 0.5, 0.1);
  assert.equal(am._selectBest().name, 'a', '5h dominates: lower 5h wins despite higher 7d');
});

test('setActiveAccount re-pins all sessions and steers new ones', () => {
  const am = makeManager(['a', 'b']);
  am.getActiveAccount('s1');
  am.getActiveAccount('s2');
  assert.equal(am.getActiveAccount('s1').name, 'a'); // both warm on primary a

  am.setActiveAccount(1); // manual switch to b
  assert.equal(am.currentIndex, 1);
  assert.equal(am.getActiveAccount('s1').name, 'b'); // in-flight session moved
  assert.equal(am.getActiveAccount('s2').name, 'b');
  assert.equal(am.getActiveAccount('s3').name, 'b'); // new session follows the new primary
});

test('setActiveAccount un-burns the chosen account for a session', () => {
  const am = makeManager(['a', 'b']);
  am.getActiveAccount('s1');
  am.sessions.get('s1').burned.add(am._identity(am.accounts[1]));
  am.setActiveAccount(1);
  assert.equal(am.sessions.get('s1').burned.has(am._identity(am.accounts[1])), false);
  assert.equal(am.getActiveAccount('s1').name, 'b');
});

// ── state persistence + quota-aware startup ───────────────────

test('exportState/importState round-trips quota and usage by identity', () => {
  const am = makeManager(['a', 'b']);
  am.accounts[0].quota.unified5h = 0.78;
  am.accounts[0].quota.unified7d = 0.23;
  am.accounts[0].usage.totalRequests = 9;
  am.accounts[0].usage.totalCacheReadTokens = 1000;
  const state = am.exportState();

  const am2 = makeManager(['a', 'b']);
  am2.importState(state);
  assert.equal(am2.accounts[0].quota.unified5h, 0.78);
  assert.equal(am2.accounts[0].quota.unified7d, 0.23);
  assert.equal(am2.accounts[0].usage.totalRequests, 9);
  assert.equal(am2.accounts[0].usage.totalCacheReadTokens, 1000);
});

test('chooseInitialPrimary starts on the most-remaining-quota account (the restart bug)', () => {
  const am = makeManager(['youlz', 'youyve']); // config order: youlz is #0
  am.accounts[0].quota.unified5h = 0.78; am.accounts[0].quota.unified7d = 0.23;
  am.accounts[1].quota.unified5h = 0.60; am.accounts[1].quota.unified7d = 0.08;
  am.chooseInitialPrimary();
  assert.equal(am.accounts[am.currentIndex].name, 'youyve', 'primary is the freshest, not config #0');
  // and a new conversation actually routes there
  assert.equal(am.getActiveAccount('news', 1000).name, 'youyve');
});

// ── rate-limit recovery (cooking-forever / stuck-bar fixes) ───

test('markRateLimited is capped at the soonest quota reset', () => {
  const am = makeManager(['a']);
  const reset = Date.now() + 5 * 60 * 1000; // 5 min away
  am.accounts[0].quota.unified5hReset = reset;
  am.markRateLimited(0, 3600); // upstream said wait an hour…
  // …but we must not park it past the actual 5h reset
  assert.ok(am.accounts[0].rateLimitedUntil <= reset + 1);
  assert.ok(am.accounts[0].rateLimitedUntil > Date.now());
});

test('refreshExpiredQuotas clears expired windows and lifts expired throttles', () => {
  const am = makeManager(['a', 'b']);
  // a: 5h window already reset in the past, but still showing old utilization
  am.accounts[0].quota.unified5h = 0.95;
  am.accounts[0].quota.unified5hReset = Date.now() - 1000;
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() - 1000;
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[0].quota.unified5h, null, 'expired 5h cleared');
  assert.equal(am.accounts[0].status, 'active', 'expired throttle lifted');
  assert.equal(am.accounts[0].rateLimitedUntil, null);
});

test('computeRetryAfter uses unified resets, not a misleading default', () => {
  const soon = Date.now() + 90 * 1000; // 90s
  const accounts = [
    { rateLimitedUntil: null, quota: { unified5hReset: soon, unified7dReset: Date.now() + 86400e3 } },
    { rateLimitedUntil: null, quota: { unified5hReset: Date.now() + 3600e3 } },
  ];
  const ra = computeRetryAfter(accounts);
  assert.ok(ra >= 80 && ra <= 95, `retry-after ~90s, got ${ra}`);
  // no reset info → falls back to 60
  assert.equal(computeRetryAfter([{ quota: {} }]), 60);
});

// ── deriveSessionKey ──────────────────────────────────────────

test('deriveSessionKey is stable across a growing conversation', () => {
  const base = {
    model: 'claude-opus-4-8',
    system: 'You are helpful.',
    tools: [{ name: 'Read' }, { name: 'Bash' }],
    messages: [{ role: 'user', content: 'first task' }],
  };
  const k1 = deriveSessionKey(Buffer.from(JSON.stringify(base)));
  const grown = { ...base, messages: [base.messages[0], { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] };
  const k2 = deriveSessionKey(Buffer.from(JSON.stringify(grown)));
  assert.equal(k1, k2); // tail growth must not change the key
});

test('deriveSessionKey distinguishes different conversations and rejects non-chat bodies', () => {
  const a = deriveSessionKey(Buffer.from(JSON.stringify({ model: 'm', system: 's', tools: [], messages: [{ role: 'user', content: 'A' }] })));
  const b = deriveSessionKey(Buffer.from(JSON.stringify({ model: 'm', system: 's', tools: [], messages: [{ role: 'user', content: 'B' }] })));
  assert.notEqual(a, b);
  assert.equal(deriveSessionKey(Buffer.from('not json')), null);
  assert.equal(deriveSessionKey(Buffer.from(JSON.stringify({ foo: 1 }))), null);
  assert.equal(deriveSessionKey(Buffer.alloc(0)), null);
});
