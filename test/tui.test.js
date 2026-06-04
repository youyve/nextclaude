import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, formatRequestLine, formatStatusText } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function makeTui() {
  const am = new AccountManager([
    { name: 'a@example.com', type: 'oauth', accessToken: 'x' },
    { name: 'b@example.com', type: 'oauth', accessToken: 'y' },
  ], 0.98);
  const a = am.accounts[0];
  a.tier = 'Max';
  a.quota.unified5h = 0.45; a.quota.unified7d = 0.18;
  a.quota.unified5hReset = Date.now() + 2 * 3600e3;
  a.quota.unified7dReset = Date.now() + 5 * 86400e3;
  a.usage.totalRequests = 84;
  a.usage.totalInputTokens = 420_000;
  a.usage.totalOutputTokens = 30_000;
  a.usage.totalCacheReadTokens = 1_200_000;
  a.usage.totalCacheCreationTokens = 84_000;
  a.usage.totalSwitchRebuilds = 1;
  am.sessions.set('k', { pinned: 'a@example.com', burned: new Set(), lastSeen: Date.now(), ctxPeak: null });
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 3456 } }, version: '1.1.0',
    saveConfig() {}, syncAccounts() {}, onQuit() {},
  });
  return { am, tui };
}

test('_buildFrame renders the card dashboard with version, summary, accounts and stats', () => {
  const { tui } = makeTui();
  const plain = stripAnsi(tui._buildFrame(120, 30));
  assert.match(plain, /NextClaude v1\.1\.0/);
  assert.match(plain, /Sessions 1/);
  assert.match(plain, /Cache \d+%/);        // true hit rate read/(read+created+input)
  assert.match(plain, /up \d/);             // uptime
  assert.match(plain, /Accounts/);
  assert.match(plain, /a@example/);
  assert.match(plain, /b@example/);
  assert.match(plain, /Max/);
  assert.match(plain, /5h/);
  assert.match(plain, /7d/);
  assert.match(plain, /84 req/);
  assert.match(plain, /cache \d+%/);        // per-account cache rate
  assert.match(plain, /rebuilt/);           // ✎<tokens> rebuilt
  assert.match(plain, /Activity/);
});

test('_buildFrame is exactly W x H and never overflows width', () => {
  const { tui } = makeTui();
  for (const [W, H] of [[40, 8], [70, 20], [120, 30], [200, 50]]) {
    const rows = tui._buildFrame(W, H).split('\r\n');
    assert.equal(rows.length, H, `${W}x${H} row count`);
    for (const row of rows) {
      assert.ok(stripAnsi(row).length <= W, `row width <= ${W}`);
    }
  }
});

test('render is re-entrancy guarded against logging during a render', () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'x' }], 0.98);
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } }, version: '1', saveConfig() {}, syncAccounts() {}, onQuit() {} });
  tui.running = true;
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  const origBuild = tui._buildFrame.bind(tui);
  let builds = 0;
  // Force a log mid-build, which _addLog would normally bounce back into render.
  tui._buildFrame = (W, H) => { builds++; if (builds < 5) tui._addLog('[NextClaude] mid-render'); return origBuild(W, H); };
  try {
    tui.render(); // must not overflow the stack
    assert.equal(builds, 1, 'nested render was blocked by the guard');
  } finally {
    process.stdout.write = origWrite;
  }
});

test('refreshExpiredQuotas logging does not crash a console-redirected TUI', () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'x' }], 0.98);
  am.accounts[0].quota.unified5h = 0.9;
  am.accounts[0].quota.unified5hReset = Date.now() - 1000; // expired -> logs on clear
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } }, version: '1', saveConfig() {}, syncAccounts() {}, onQuit() {} });
  tui.running = true;
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  process.stdout.write = () => true;
  console.log = (...a) => tui._addLog(a.join(' ')); // mimic start()'s redirect
  try {
    am.refreshExpiredQuotas(); // "session quota reset" -> _addLog -> render
    tui.render();
    assert.equal(am.accounts[0].quota.unified5h, null, 'expired quota cleared, no crash');
  } finally {
    console.log = origLog;
    process.stdout.write = origWrite;
  }
});

test('formatRequestLine shows the cache hit/miss split for a warm request', () => {
  const line = stripAnsi(formatRequestLine({
    status: 200, acct: 'b@example.com', dur: '3.0', method: 'POST', path: '/v1/messages',
    usage: { input: 1500, output: 512, cacheCreation: 0, cacheRead: 138000 },
  }));
  assert.match(line, /200\s+3\.0s\s+b@example/);
  assert.match(line, /hit\s+138k/);
  assert.match(line, /miss\s+1\.5k/);
  assert.match(line, /↓\s*512/);
  assert.match(line, /99%/); // 138000 / (138000+1500)
});

test('formatRequestLine flags a cold rebuild with ✎ and a low hit rate', () => {
  const line = stripAnsi(formatRequestLine({
    status: 200, acct: 'a', dur: '91.0', method: 'POST', path: '/v1/messages',
    usage: { input: 2000, output: 2100, cacheCreation: 150000, cacheRead: 11000 },
  }));
  assert.match(line, /hit\s+11k/);
  assert.match(line, /miss\s+152k/);   // 150000 + 2000
  assert.match(line, /✎\s*150k/);
  assert.match(line, /7%/);            // 11000 / 163000
});

test('formatRequestLine columns are fixed-width so successive rows align', () => {
  const a = formatRequestLine({ status: 200, acct: 'b@example.com', dur: '2.0', usage: { input: 100, output: 7, cacheCreation: 0, cacheRead: 141000 } });
  const b = formatRequestLine({ status: 200, acct: 'b@example.com', dur: '25.2', usage: { input: 1400, output: 1300, cacheCreation: 0, cacheRead: 821000 } });
  const idx = s => stripAnsi(s).indexOf('hit');
  assert.equal(idx(a), idx(b), 'the hit column starts at the same offset regardless of dur width');
});

test('formatRequestLine falls back to method+path for non-chat / no-usage requests', () => {
  const line = stripAnsi(formatRequestLine({
    status: 429, acct: '(none)', dur: '0.0', method: 'POST', path: '/v1/messages',
    usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
  }));
  assert.match(line, /429\s+0\.0s\s+\(none\)/);
  assert.match(line, /POST \/v1\/messages/);
  assert.doesNotMatch(line, /hit\s/);
});

test('_buildFrame shows the cache summary, legend, and a per-request activity row', () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'x' }], 0.98);
  Object.assign(am.accounts[0].usage, {
    totalRequests: 10, totalInputTokens: 5000, totalOutputTokens: 8000,
    totalCacheReadTokens: 900000, totalCacheCreationTokens: 100000,
  });
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } }, version: '1.3.0', saveConfig() {}, syncAccounts() {}, onQuit() {} });
  tui.active.set(1, { method: 'POST', path: '/v1/messages', t: '12:00', started: Date.now() - 3000, account: 'a' });
  tui.onRequestEnd(1, { method: 'POST', path: '/v1/messages', account: 'a', status: 200, usage: { input: 1000, output: 200, cacheCreation: 0, cacheRead: 90000 } });
  const plain = stripAnsi(tui._buildFrame(132, 24));
  assert.match(plain, /Cache 90%/);            // 900k / (900k+100k+5k) ≈ 90%
  assert.match(plain, /served from cache/);    // legend
  assert.match(plain, /cache \d+%/);           // per-account
  assert.match(plain, /hit\s+90k/);            // the activity row
});

test('formatStatusText shows the cache breakdown for the headless status command', () => {
  const data = {
    currentAccount: 'b', switchThreshold: 0.98, activeSessions: 2, manual: 'b',
    accounts: [
      { name: 'a', identity: 'a', type: 'oauth', tier: 'Pro', status: 'active', rateLimitedUntil: null,
        quota: { unified5h: 0.43, unified7d: 0.30 },
        usage: { totalRequests: 84, totalInputTokens: 42000, totalOutputTokens: 46000, totalCacheReadTokens: 2240000, totalCacheCreationTokens: 120000, totalSwitchRebuilds: 1 } },
      { name: 'b', identity: 'b', type: 'oauth', tier: 'Pro', status: 'active', rateLimitedUntil: null,
        quota: { unified5h: 0.05, unified7d: 0.13 },
        usage: { totalRequests: 7, totalInputTokens: 2000, totalOutputTokens: 12000, totalCacheReadTokens: 520000, totalCacheCreationTokens: 150000, totalSwitchRebuilds: 1 } },
    ],
  };
  const out = formatStatusText(data, '1.3.1');
  assert.match(out, /NextClaude v1\.3\.1/);
  assert.match(out, /cache hit 90% overall/);
  assert.match(out, /cache: 93% hit · 2\.2M read · ✎120k rebuilt \(1 cold\)/);
  assert.match(out, /5h: 43% used/);
  assert.match(out, /★ manual/);                 // marked on account b
  assert.ok(out.includes('> b'), 'current account marked with >');
  assert.doesNotMatch(out, /\x1b\[/, 'plain text, no ANSI');
});

test('_buildFrame handles the no-accounts case', () => {
  const am = new AccountManager([], 0.98);
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } }, version: '1.1.0', saveConfig() {}, syncAccounts() {}, onQuit() {} });
  const plain = stripAnsi(tui._buildFrame(100, 24));
  assert.match(plain, /No accounts configured/);
});
