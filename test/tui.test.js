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
  a.quota.unified5hReset = 1; // formatReset returns '' for past ts; fine for tests
  a.usage.totalRequests = 84;
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

test('_buildFrame renders the dashboard with version, summary, accounts and stats', () => {
  const { tui } = makeTui();
  const plain = stripAnsi(tui._buildFrame(120, 30));
  assert.match(plain, /NextClaude/);
  assert.match(plain, /v1\.1\.0/);
  assert.match(plain, /Sessions 1/);
  assert.match(plain, /Cache 1\.2M read \/ 84k rebuilt/);
  assert.match(plain, /warm 93%/);          // 1.2M / (1.2M+84k)
  assert.match(plain, /youlz@gmail/);
  assert.match(plain, /youyve@foxmail/);
  assert.match(plain, /Max/);
  assert.match(plain, /Ses/);
  assert.match(plain, /Wk/);
  assert.match(plain, /req 84/);            // showStats at W=120
  assert.match(plain, /rb 1/);
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

test('_buildFrame handles the no-accounts case', () => {
  const am = new AccountManager([], 0.98);
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } }, version: '1.1.0', saveConfig() {}, syncAccounts() {}, onQuit() {} });
  const plain = stripAnsi(tui._buildFrame(100, 24));
  assert.match(plain, /No accounts configured/);
});
