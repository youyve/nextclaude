import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function makeTui() {
  const am = new AccountManager([
    { name: 'youlz@gmail.com', type: 'oauth', accessToken: 'x' },
    { name: 'youyve@foxmail.com', type: 'oauth', accessToken: 'y' },
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
  am.sessions.set('k', { pinned: 'youlz@gmail.com', burned: new Set(), lastSeen: Date.now(), ctxPeak: null });
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
  assert.match(plain, /Warm 93%/);          // 1.2M / (1.2M+84k)
  assert.match(plain, /up \d/);             // uptime
  assert.match(plain, /Accounts/);
  assert.match(plain, /youlz@gmail/);
  assert.match(plain, /youyve@foxmail/);
  assert.match(plain, /Max/);
  assert.match(plain, /5h/);
  assert.match(plain, /7d/);
  assert.match(plain, /84 req/);
  assert.match(plain, /1 rebuild/);
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

test('_buildFrame handles the no-accounts case', () => {
  const am = new AccountManager([], 0.98);
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } }, version: '1.1.0', saveConfig() {}, syncAccounts() {}, onQuit() {} });
  const plain = stripAnsi(tui._buildFrame(100, 24));
  assert.match(plain, /No accounts configured/);
});
