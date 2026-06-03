import { importCredentials, fetchProfile } from './oauth.js';

// ── ANSI helpers ─────────────────────────────────────────────

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.split('');
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

const bold = s => `${BOLD}${s}${RESET}`;
const dim = s => `${DIM}${s}${RESET}`;
const fg = (c, s) => `${ESC}${c}m${s}${RESET}`;
const green = s => fg(32, s);
const yellow = s => fg(33, s);
const red = s => fg(31, s);
const cyan = s => fg(36, s);
const gray = s => fg(90, s);

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = s => s.replace(ANSI_RE, '');
const vw = s => strip(s).length;

/** Truncate a string with ANSI codes to exactly w visible characters, then reset. */
function truncate(s, w) {
  let visible = 0;
  let out = '';
  let i = 0;
  while (i < s.length && visible < w) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end >= 0) { out += s.slice(i, end + 1); i = end + 1; continue; }
    }
    out += s[i];
    visible++;
    i++;
  }
  return out + RESET;
}

/** Fit a line to exactly w columns: truncate if too long, pad if too short. */
function fitLine(s, w) {
  const v = vw(s);
  if (v > w) return truncate(s, w);
  if (v < w) return s + ' '.repeat(w - v);
  return s;
}

function formatReset(resetTs) {
  if (!resetTs) return '';
  const ms = resetTs - Date.now();
  if (ms <= 0) return '';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d${rh}h` : `${days}d`;
}

/** Compact human number: 1234 -> 1.2k, 1_500_000 -> 1.5M. */
function fmtNum(n) {
  if (n == null) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

// ── rounded-box drawing (ANSI-width aware; borders dim, title bold) ──
const hline = n => '─'.repeat(Math.max(0, n));

function boxTop(W, title, right = '') {
  const fill = Math.max(0, W - (4 + vw(title)) - (right ? 4 + vw(right) : 2));
  const tail = right ? ` ${right}${dim(' ─╮')}` : dim('─╮');
  return dim('╭─ ') + bold(title) + ' ' + dim(hline(fill)) + tail;
}
function boxSep(W, title) {
  const fill = Math.max(0, W - (4 + vw(title)) - 1);
  return dim('├─ ') + bold(title) + ' ' + dim(hline(fill) + '┤');
}
function boxRow(W, content = '') {
  return dim('│') + fitLine(' ' + content, W - 2) + dim('│');
}
function boxBottom(W, footer = '') {
  if (!footer) return dim('╰' + hline(W - 2) + '╯');
  const fill = Math.max(0, W - (4 + vw(footer)) - 1);
  return dim('╰─ ') + footer + ' ' + dim(hline(fill) + '╯');
}

/** Solid progress bar (no overlaid text), colored by load. */
function barBlocks(ratio, w) {
  if (ratio == null || isNaN(ratio)) return gray('░'.repeat(w));
  ratio = Math.max(0, Math.min(1, ratio));
  const f = Math.round(ratio * w);
  const color = ratio < 0.7 ? green : ratio < 0.9 ? yellow : red;
  return color('█'.repeat(f)) + gray('░'.repeat(w - f));
}

function colorStatus(status, isCur) {
  switch (status) {
    case 'active':    return isCur ? green('active') : 'active';
    case 'throttled': return yellow('throttled');
    case 'exhausted': return red('exhausted');
    case 'error':     return red('error');
    default:          return status || 'ready';
  }
}

/** Tint a completed-activity line by outcome. */
function colorLogMsg(msg) {
  if (/\b429\b/.test(msg)) return yellow(msg);
  if (/error|502|exhausted|fail/i.test(msg)) return red(msg);
  return msg;
}

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ── TUI class ────────────────────────────────────────────────

export class TUI {
  constructor({ accountManager, config, saveConfig, syncAccounts, onQuit, version }) {
    this.am = accountManager;
    this.config = config;
    this.version = version || '';
    this.startedAt = Date.now();
    this.saveConfig = saveConfig;
    this.syncAccounts = syncAccounts;
    this.onQuit = onQuit;

    this.log = [];           // completed activity entries
    this.active = new Map(); // in-flight requests
    this.mode = 'normal';    // normal | select | add | input
    this.selAction = null;   // switch | remove
    this.selIdx = 0;
    this.inputPrompt = '';
    this.inputBuf = '';
    this.inputCb = null;
    this.frame = 0;
    this.running = false;
    this.timer = null;
    this._origLog = null;
    this._origErr = null;
  }

  // ── lifecycle ──────────────────────────────────────

  start() {
    this.running = true;
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    this._dataHandler = d => this._onData(d);
    this._resizeHandler = () => this.render();
    process.stdin.on('data', this._dataHandler);
    process.stdout.on('resize', this._resizeHandler);

    // Redirect console to activity log
    this._origLog = console.log;
    this._origErr = console.error;
    console.log = (...a) => this._addLog(a.join(' '));
    console.error = (...a) => this._addLog(a.join(' '));

    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.render();
    }, 500);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._origLog) { console.log = this._origLog; console.error = this._origErr; }
    process.stdin.removeListener('data', this._dataHandler);
    process.stdout.removeListener('resize', this._resizeHandler);
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
  }

  // ── server hooks ───────────────────────────────────

  onRequestStart(id, info) {
    this.active.set(id, { ...info, t: timestamp(), started: Date.now(), account: null });
    this.render();
  }

  onRequestRouted(id, info) {
    const r = this.active.get(id);
    if (r) r.account = info.account;
  }

  onRequestEnd(id, info) {
    const r = this.active.get(id);
    this.active.delete(id);
    const dur = r ? ((Date.now() - r.started) / 1000).toFixed(1) : '?';
    const acct = info.account || r?.account || '?';
    this._addLog(`${info.method} ${info.path} → ${acct} (${info.status}, ${dur}s)`);
  }

  _addLog(msg) {
    msg = msg.replace(/^\[NextClaude\]\s*/, '');
    this.log.unshift({ t: timestamp(), msg });
    if (this.log.length > 200) this.log.length = 200;
    if (this.running) this.render();
  }

  // ── input handling ─────────────────────────────────

  _onData(d) {
    if (d === '\x1b[A') return this._key('up');
    if (d === '\x1b[B') return this._key('down');
    if (d === '\x1b') return this._key('esc');
    if (d === '\r' || d === '\n') return this._key('enter');
    if (d === '\x03') return this._key('ctrl-c');
    if (d === '\x7f' || d === '\x08') return this._key('bs');
    if (d.length === 1 && d >= ' ') return this._key(d);
  }

  _key(k) {
    if (k === 'ctrl-c') { this.stop(); this.onQuit?.(); return; }

    switch (this.mode) {
      case 'normal': this._keyNormal(k); break;
      case 'select': this._keySelect(k); break;
      case 'add':    this._keyAdd(k); break;
      case 'input':  this._keyInput(k); break;
    }
    this.render();
  }

  _keyNormal(k) {
    if (k === 'q') { this.stop(); this.onQuit?.(); }
    else if (k === 's' && this.am.accounts.length > 0) {
      this.mode = 'select'; this.selAction = 'switch'; this.selIdx = this.am.currentIndex;
    }
    else if (k === 'r' && this.am.accounts.length > 0) {
      this.mode = 'select'; this.selAction = 'remove'; this.selIdx = 0;
    }
    else if (k === 'a') { this.mode = 'add'; }
    else if (k === 'R') { this._doSync(); }
  }

  _keySelect(k) {
    const len = this.am.accounts.length;
    if (k === 'up' || k === 'k') this.selIdx = Math.max(0, this.selIdx - 1);
    else if (k === 'down' || k === 'j') this.selIdx = Math.min(len - 1, this.selIdx + 1);
    else if (k === 'enter') {
      if (this.selAction === 'switch') {
        this.am.setActiveAccount(this.selIdx);
        this._addLog(`Switched all traffic to "${this.am.accounts[this.selIdx].name}"`);
      } else {
        this._doRemove(this.selIdx);
      }
      this.mode = 'normal';
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _keyAdd(k) {
    if (k === 'i') { this._doImport(); this.mode = 'normal'; }
    else if (k === 'k') {
      this.mode = 'input';
      this.inputPrompt = 'API key';
      this.inputBuf = '';
      this.inputCb = v => { if (v) this._doAddKey(v); };
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _keyInput(k) {
    if (k === 'enter') {
      const cb = this.inputCb;
      const v = this.inputBuf;
      this.mode = 'normal'; this.inputCb = null; this.inputBuf = '';
      cb?.(v);
    }
    else if (k === 'esc') { this.mode = 'normal'; this.inputCb = null; this.inputBuf = ''; }
    else if (k === 'bs') { this.inputBuf = this.inputBuf.slice(0, -1); }
    else if (k.length === 1) { this.inputBuf += k; }
  }

  // ── account operations ─────────────────────────────

  async _doSync() {
    try {
      const count = await this.syncAccounts();
      if (count > 0) {
        this._addLog(`Synced ${count} new account(s) from config`);
      } else {
        this._addLog('Config reloaded, credentials refreshed');
      }
    } catch (e) {
      this._addLog(`Sync failed: ${e.message}`);
    }
  }

  async _doImport() {
    try {
      this._addLog('Importing credentials...');
      const creds = await importCredentials('~/.claude/.credentials.json');
      const profile = await fetchProfile(creds.accessToken);
      const profileOk = profile && !profile.error;

      if (!profileOk) {
        this._addLog(`Warning: could not fetch profile — ${profile?.error || 'no token'}`);
      }

      let name;
      if (profile?.email) {
        name = profile.email;
        const tier = profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : null;
        if (tier) this._addLog(`Detected Claude ${tier}: ${name}`);
      } else {
        const n = this.config.accounts.filter(a => a.name.startsWith('account-')).length + 1;
        name = `account-${n}`;
      }

      const entry = {
        name, type: 'oauth', source: 'import',
        accountUuid: profile?.accountUuid || null,
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
      };

      // Deduplicate: match by UUID first, then by name
      let idx = profile?.accountUuid
        ? this.config.accounts.findIndex(a => a.accountUuid === profile.accountUuid)
        : -1;
      if (idx < 0) idx = this.config.accounts.findIndex(a => a.name === name);

      if (idx >= 0) {
        this.config.accounts[idx] = entry;
        // Update the running account manager entry
        const amAcct = this.am.accounts[idx];
        if (amAcct) {
          amAcct.credential = creds.accessToken;
          amAcct.refreshToken = creds.refreshToken;
          amAcct.expiresAt = creds.expiresAt;
          amAcct.accountUuid = entry.accountUuid;
          amAcct.name = name;
          if (amAcct.status === 'error') amAcct.status = 'active';
        }
        this._addLog(`Updated account "${name}"`);
      } else {
        this.config.accounts.push(entry);
        this.am.addAccount(entry);
        this._addLog(`Imported account "${name}"`);
      }

      await this.saveConfig(this.config);
    } catch (e) {
      this._addLog(`Import failed: ${e.message}`);
    }
  }

  async _doAddKey(apiKey) {
    const n = this.config.accounts.filter(a => a.name.startsWith('api-')).length + 1;
    const name = `api-${n}`;
    this.config.accounts.push({ name, type: 'apikey', apiKey });
    this.am.addAccount({ name, type: 'apikey', apiKey });
    await this.saveConfig(this.config);
    this._addLog(`Added API key account "${name}"`);
  }

  async _doRemove(idx) {
    if (idx < 0 || idx >= this.am.accounts.length) return;
    const name = this.am.accounts[idx].name;
    this.am.removeAccount(idx);
    this.config.accounts.splice(idx, 1);
    if (this.selIdx >= this.am.accounts.length) this.selIdx = Math.max(0, this.am.accounts.length - 1);
    await this.saveConfig(this.config);
    this._addLog(`Removed account "${name}"`);
  }

  // ── rendering ──────────────────────────────────────

  render() {
    if (!this.running) return;
    // Clear expired quota windows even while idle so bars reset on their own.
    this.am.refreshExpiredQuotas?.();
    const W = process.stdout.columns || 80;
    const H = process.stdout.rows || 24;

    if (W < 40 || H < 8) {
      process.stdout.write(`${ESC}H${ESC}2JTerminal too small (need 40x8+)\r\n`);
      return;
    }

    let buf = `${ESC}H` + this._buildFrame(W, H);
    // Show cursor only in input mode
    buf += this.mode === 'input' ? `${ESC}?25h` : `${ESC}?25l`;
    process.stdout.write(buf);
  }

  /**
   * Build the full terminal frame as a string (pure — no stdout/isTTY access,
   * so it can be unit-tested). Returns exactly H rows joined by CRLF, each W wide.
   */
  _buildFrame(W, H) {
    const port = this.config.proxy?.port || 3456;
    const ver = this.version ? `NextClaude v${this.version}` : 'NextClaude';

    const top = [
      boxTop(W, ver, `${green('●')} :${port}`),
      boxRow(W, this._summaryLine()),
      boxSep(W, 'Accounts'),
    ];

    // Account cards (each is several content rows)
    let cardRows;
    if (this.am.accounts.length === 0) {
      cardRows = [boxRow(W, yellow('No accounts configured. Press [a] to add one.'))];
    } else {
      cardRows = [];
      for (let i = 0; i < this.am.accounts.length; i++) {
        for (const c of this._renderCard(i, W)) cardRows.push(boxRow(W, c));
      }
    }

    const ac = this.active.size;
    const actSep = boxSep(W, `Activity${ac ? '  ' + cyan(ac + ' active') : ''}`);
    const bottom = boxBottom(W, this._renderFooter());

    // Split the remaining height between cards and the activity log.
    const room = Math.max(0, H - top.length - 2); // minus actSep + bottom
    const shownCards = cardRows.slice(0, Math.max(1, room - 1));
    const actRoom = Math.max(0, room - shownCards.length);
    const actRows = this._activityRows().slice(0, actRoom).map(c => boxRow(W, c));
    while (actRows.length < actRoom) actRows.push(boxRow(W, ''));

    const lines = [...top, ...shownCards, actSep, ...actRows, bottom];
    let out = '';
    for (let i = 0; i < H; i++) {
      out += fitLine(lines[i] || boxRow(W, ''), W);
      if (i < H - 1) out += '\r\n';
    }
    return out;
  }

  /** Header summary: sessions · reqs · warm% · tokens · uptime. */
  _summaryLine() {
    let read = 0, created = 0, reqs = 0, tin = 0, tout = 0;
    for (const a of this.am.accounts) {
      read += a.usage.totalCacheReadTokens || 0;
      created += a.usage.totalCacheCreationTokens || 0;
      reqs += a.usage.totalRequests || 0;
      tin += a.usage.totalInputTokens || 0;
      tout += a.usage.totalOutputTokens || 0;
    }
    const sessions = this.am.sessions ? this.am.sessions.size : 0;
    const warmPct = (read + created) > 0 ? Math.round((read / (read + created)) * 100) : null;
    const warm = warmPct == null ? gray('Warm —')
      : (warmPct >= 80 ? green : warmPct >= 50 ? yellow : red)(`Warm ${warmPct}%`);
    const dot = dim(' · ');
    return [
      `${gray('Sessions')} ${sessions}`,
      `${gray('Reqs')} ${reqs}`,
      warm,
      `${dim('↑' + fmtNum(tin))} ${dim('↓' + fmtNum(tout))}`,
      `${gray('up')} ${fmtUptime(Date.now() - this.startedAt)}`,
    ].join(dot);
  }

  /** Render one account as an array of content lines (a "card"). */
  _renderCard(idx, W) {
    const a = this.am.accounts[idx];
    const isCur = idx === this.am.currentIndex;
    const isSel = this.mode === 'select' && idx === this.selIdx;
    const marker = isCur ? green('▶') : (isSel ? cyan('▷') : ' ');

    const nm = a.name.length > 30 ? a.name.slice(0, 29) + '…' : a.name;
    const name = isSel ? bold(nm) : nm;
    const tier = gray(a.tier || (a.type === 'apikey' ? 'API' : 'Sub'));
    const status = colorStatus(a.status, isCur);
    const bw = Math.max(8, Math.min(28, W - 34));

    const q = a.quota;
    let r1, r2, l1 = '5h', l2 = '7d', t1, t2;
    if (q.unified5h != null || q.unified7d != null) {
      r1 = q.unified5h; r2 = q.unified7d; t1 = q.unified5hReset; t2 = q.unified7dReset;
    } else {
      l1 = 'Tok'; l2 = 'Req';
      r1 = (q.tokensLimit != null && q.tokensRemaining != null) ? 1 - q.tokensRemaining / q.tokensLimit : null;
      r2 = (q.requestsLimit != null && q.requestsRemaining != null) ? 1 - q.requestsRemaining / q.requestsLimit : null;
      t1 = q.resetsAt ? new Date(q.resetsAt).getTime() : null; t2 = t1;
    }
    const pct = r => (r == null ? '  -' : `${Math.round(r * 100)}%`).padStart(4);
    const rst = ts => { const r = formatReset(ts); return r ? `${dim('⟳')} ${dim(r)}` : ''; };
    const quotaRow = (lab, r, ts) => `${gray(lab)} ${barBlocks(r, bw)} ${pct(r)}  ${rst(ts)}`;

    const u = a.usage;
    const rb = u.totalSwitchRebuilds || 0;
    const stats = [
      dim(`${fmtNum(u.totalRequests || 0)} req`),
      rb > 0 ? red(`${rb} rebuild`) : dim('0 rebuild'),
      dim(`↑${fmtNum(u.totalInputTokens || 0)} ↓${fmtNum(u.totalOutputTokens || 0)}`),
    ].join(dim(' · '));

    const card = [
      `${marker} ${name}   ${tier} ${dim('·')} ${status}`,
      `  ${quotaRow(l1, r1, t1)}`,
      `  ${quotaRow(l2, r2, t2)}`,
      `  ${stats}`,
    ];
    if (idx < this.am.accounts.length - 1) card.push('');
    return card;
  }

  /** Activity rows (in-flight first, then completed log), as content strings. */
  _activityRows() {
    const rows = [];
    const now = Date.now();
    for (const [, r] of this.active) {
      const el = ((now - r.started) / 1000).toFixed(1);
      const sp = cyan(SPINNER[this.frame]);
      const acct = r.account ? ` ${dim('→')} ${cyan(r.account)}` : '';
      rows.push(`${sp} ${gray(r.t)} ${r.method} ${r.path}${acct} ${dim(`${el}s…`)}`);
    }
    for (const e of this.log) {
      rows.push(`${gray(e.t)}  ${colorLogMsg(e.msg)}`);
    }
    return rows;
  }

  _renderFooter() {
    switch (this.mode) {
      case 'normal':
        return ` ${bold('s')}witch  ${bold('a')}dd  ${bold('r')}emove  ${bold('R')}eload  ${bold('q')}uit`;
      case 'select': {
        const act = this.selAction === 'switch' ? 'switch' : 'remove';
        return ` ${dim('↑↓')} select  ${bold('Enter')} ${act}  ${bold('Esc')} cancel`;
      }
      case 'add':
        return ` ${bold('i')}mport Claude Code  ${bold('k')} API key  ${bold('Esc')} cancel`;
      case 'input':
        return ` ${this.inputPrompt}: ${this.inputBuf}█`;
      default:
        return '';
    }
  }
}
