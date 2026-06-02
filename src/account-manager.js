import { refreshAccessToken, isTokenExpiringSoon } from './oauth.js';

function emptyQuota() {
  return {
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    // Unified rate limits (Claude Max accounts)
    unified5h: null,       // utilization 0-1
    unified7d: null,       // utilization 0-1
    unified5hReset: null,  // ms timestamp
    unified7dReset: null,  // ms timestamp
    unifiedStatus: null,   // allowed | allowed_warning | rejected
    resetsAt: null,
  };
}

function emptyUsage() {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    // Prompt-cache accounting (Layer 0): cache_creation = expensive cold rebuild
    // writes (~1.25x), cache_read = cheap warm-prefix hits (~0.1x). High
    // cache_read + ~0 cache_creation on a bound account confirms affinity is
    // keeping it warm; a cache_creation spike marks a switch-induced rebuild.
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    lastCacheReadTokens: null,      // most recent request's cache_read (Layer 2 trough signal)
    lastCacheCreationTokens: null,
    totalRequests: 0,
    totalSwitchRebuilds: 0,         // count of switch-induced cold rebuilds observed
    lastUsed: null,
  };
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98) {
    this.accounts = accounts.map((acct, index) => ({
      index,
      name: acct.name,
      type: acct.type,
      accountUuid: acct.accountUuid || null,
      credential: acct.accessToken || acct.apiKey,
      refreshToken: acct.refreshToken || null,
      expiresAt: acct.expiresAt || null,
      status: 'active',
      quota: emptyQuota(),
      usage: emptyUsage(),
      rateLimitedUntil: null,
    }));
    this.currentIndex = 0;
    this.switchThreshold = switchThreshold;

    // Per-conversation account affinity (Layer 1): pin each session to one
    // account and never switch back to a cache-cold account it already left.
    // Keyed by a body-derived session hash (see server.js deriveSessionKey).
    // Value: { pinned: identity, burned: Set<identity>, lastSeen: ms }.
    // Identity is accountUuid||name so it survives removeAccount() reindexing.
    this.sessions = new Map();
    this._sessionTtlMs = 30 * 60 * 1000; // forget idle conversations after 30m
    this._maxSessions = 2000;

    // Layer 2 — compaction-aware lazy switching.
    // switchThreshold (soft, ~0.98) only ARMS a session: once a pinned account
    // crosses it we are eligible to switch, but we defer and ride the warm cache,
    // waiting for the client to auto-compact (a sharp drop in request body size)
    // so the unavoidable rebuild lands on a small prefix instead of the peak.
    // hardThreshold (and a 'rejected' status / real quota-429) is the backstop:
    // we switch immediately regardless of context, so deferral is never worse
    // than the old eager 0.98 switch and never causes a user-visible rejection.
    this.hardThreshold = 0.995;
    this._troughDropRatio = 0.5;      // switch when context shrinks below 50% of its peak
    this._troughMinPeakBytes = 50000; // ignore tiny conversations (~12K tokens)
  }

  /**
   * Get the account that should serve this request.
   *
   * With a sessionKey (Layer 1: per-conversation affinity) the conversation is
   * pinned to one account and stays there while it is available — so its large
   * prompt-cache prefix keeps hitting cache_read (~0.1x) on a warm org instead
   * of being re-billed as cache_creation (~1.25x) on a cold one. When the pinned
   * account is genuinely exhausted we switch FORWARD only: the old account is
   * "burned" for this session and never re-selected (its cache died at the 5min
   * TTL long ago, so returning would just pay another full rebuild). This holds
   * the realized rebuild count at the N-1 floor and fixes the concurrent-session
   * bug where the single global currentIndex let interleaved conversations flip
   * each other's account and trigger cold rebuilds.
   *
   * Without a sessionKey (non-JSON body / fallback) it keeps the legacy global
   * behavior. Returns null if all accounts are exhausted.
   */
  getActiveAccount(sessionKey = null, contextSize = null) {
    if (!sessionKey) {
      const current = this.accounts[this.currentIndex];
      if (this._isAvailable(current)) return current;
      return this._selectNext();
    }

    let sess = this.sessions.get(sessionKey);
    if (!sess) {
      sess = { pinned: null, burned: new Set(), lastSeen: Date.now(), ctxPeak: null };
      this.sessions.set(sessionKey, sess);
      this._evictSessions();
    }
    sess.lastSeen = Date.now();

    const pinned = sess.pinned ? this._byIdentity(sess.pinned) : null;
    if (pinned && this._isAvailable(pinned)) {
      this.currentIndex = pinned.index;

      // Layer 2: the pinned account is past the soft threshold and will have to
      // be left soon. Defer that switch and ride the warm cache until the client
      // auto-compacts — detected as a sharp drop in request size — so the
      // unavoidable rebuild lands on the small post-compaction prefix. Only
      // pre-empt if there is a meaningfully fresher account to move to.
      if (this._inWarningZone(pinned) && this._detectTrough(sess, contextSize)) {
        const exclude = new Set(sess.burned);
        exclude.add(sess.pinned);
        const better = this._selectBest(exclude);
        if (better && this._utilization(better) < this._utilization(pinned) - 0.1) {
          console.log(`[NextClaude] Compaction trough — switching session "${this._shortKey(sessionKey)}" → "${better.name}" to shrink the rebuild`);
          sess.burned.add(sess.pinned);
          sess.pinned = this._identity(better);
          sess.ctxPeak = contextSize;
          this.currentIndex = better.index;
          return better;
        }
      }
      return pinned;
    }

    // Pinned account hit the hard ceiling / is gone: switch forward.
    return this._switchSession(sess, sessionKey, contextSize);
  }

  /**
   * Move a session off its (exhausted) pinned account. Burns it so we never
   * switch back to its cold cache, picks the most-headroom non-burned account,
   * and only as a last resort (all burned) clears the set and falls back to the
   * soonest-resetting account — preserving the terminal all-exhausted path.
   */
  _switchSession(sess, sessionKey, contextSize = null) {
    if (sess.pinned) sess.burned.add(sess.pinned);
    let next = this._selectBest(sess.burned);
    if (!next) {
      sess.burned.clear();
      next = this._selectBest() || this._selectSoonestReset();
    }
    if (next) {
      if (sess.pinned && sess.pinned !== this._identity(next)) {
        console.log(`[NextClaude] Session switched "${this._shortKey(sessionKey)}" → "${next.name}"`);
      }
      sess.pinned = this._identity(next);
      sess.ctxPeak = contextSize;
      this.currentIndex = next.index;
    }
    return next;
  }

  /**
   * Detect a client-side auto-compaction: the request body (a free proxy for
   * context size) dropping sharply below this session's running peak. Because
   * the client resends the FULL history each turn, a short reply like "yes"
   * still carries the whole prefix and does NOT shrink the body — only a real
   * compaction does. Rebaselines on detection so it fires once per compaction.
   */
  _detectTrough(sess, contextSize) {
    if (contextSize == null) return false;
    if (sess.ctxPeak == null) { sess.ctxPeak = contextSize; return false; }
    if (contextSize > sess.ctxPeak) { sess.ctxPeak = contextSize; return false; }
    if (sess.ctxPeak >= this._troughMinPeakBytes && contextSize < sess.ctxPeak * this._troughDropRatio) {
      sess.ctxPeak = contextSize; // rebaseline so we don't keep firing on the small prefix
      return true;
    }
    return false;
  }

  /**
   * Public: is a just-received 429 a genuine quota rejection (switch accounts)
   * rather than a transient burst limit (wait and retry the same account)?
   */
  isQuotaRejection(accountIndex) {
    const a = this.accounts[accountIndex];
    if (!a) return false;
    this._clearExpiredQuotas(a);
    return this._mustSwitch(a) || this._inWarningZone(a);
  }

  // ── Layer 1 helpers ──────────────────────────────────

  _identity(account) {
    return account.accountUuid || account.name;
  }

  _byIdentity(identity) {
    return this.accounts.find(a => this._identity(a) === identity) || null;
  }

  _shortKey(key) {
    return typeof key === 'string' ? key.slice(0, 8) : String(key);
  }

  /**
   * Normalized utilization 0-1 for ranking (max of any tracked quota).
   * Accounts with no quota data yet score 0 (treated as freshest).
   */
  _utilization(account) {
    const q = account.quota;
    if (q.unified5h != null || q.unified7d != null) {
      return Math.max(q.unified5h || 0, q.unified7d || 0);
    }
    let u = 0;
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      u = Math.max(u, 1 - q.tokensRemaining / q.tokensLimit);
    }
    if (q.requestsLimit != null && q.requestsRemaining != null) {
      u = Math.max(u, 1 - q.requestsRemaining / q.requestsLimit);
    }
    return u;
  }

  /**
   * Pick the available account with the most remaining quota (lowest
   * utilization), optionally excluding a set of burned identities. Maximizing
   * survival on the chosen account minimizes the total number of forced
   * switches — and thus the number of cold rebuilds — over a long task.
   */
  _selectBest(exclude = null) {
    let best = null;
    let bestUtil = Infinity;
    for (const account of this.accounts) {
      if (exclude && exclude.has(this._identity(account))) continue;
      if (!this._isAvailable(account)) continue;
      const u = this._utilization(account);
      if (u < bestUtil) { bestUtil = u; best = account; }
    }
    return best;
  }

  /**
   * Terminal fallback: every account is unavailable. Reactivate and return the
   * one that resets soonest, if its reset time has already passed.
   */
  _selectSoonestReset() {
    let soonestAccount = null;
    let soonestTime = Infinity;
    for (const account of this.accounts) {
      const resetTime = account.rateLimitedUntil
        || account.quota.unified5hReset
        || account.quota.unified7dReset
        || (account.quota.resetsAt ? new Date(account.quota.resetsAt).getTime() : null);
      if (resetTime && resetTime < soonestTime) {
        soonestTime = resetTime;
        soonestAccount = account;
      }
    }
    if (soonestAccount && soonestTime <= Date.now()) {
      soonestAccount.status = 'active';
      soonestAccount.rateLimitedUntil = null;
      this.currentIndex = soonestAccount.index;
      console.log(`[NextClaude] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }
    return null;
  }

  /** Drop idle / overflow sessions so the affinity map can't grow unbounded. */
  _evictSessions() {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if (now - s.lastSeen > this._sessionTtlMs) this.sessions.delete(k);
    }
    if (this.sessions.size > this._maxSessions) {
      const sorted = [...this.sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      const drop = this.sessions.size - this._maxSessions;
      for (let i = 0; i < drop; i++) this.sessions.delete(sorted[i][0]);
    }
  }

  /**
   * Can this account serve a request at all right now? An account in the soft
   * warning zone is still "available" — Layer 2 keeps using it deliberately and
   * decides when to switch in getActiveAccount(). Only the hard ceiling (or an
   * error/exhausted/throttled status) makes it unavailable.
   */
  _isAvailable(account) {
    if (!account) return false;

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (Date.now() < account.rateLimitedUntil) return false;
      account.status = 'active';
      account.rateLimitedUntil = null;
      console.log(`[NextClaude] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.status === 'exhausted' || account.status === 'error') return false;
    this._clearExpiredQuotas(account);
    if (this._mustSwitch(account)) return false;

    return true;
  }

  /** Reset utilization tracking once a quota window's reset time has passed. */
  _clearExpiredQuotas(account) {
    const q = account.quota;
    const now = Date.now();
    if (q.unified5h != null && q.unified5hReset && now >= q.unified5hReset) {
      console.log(`[NextClaude] Account "${account.name}" session quota reset`);
      q.unified5h = null;
      q.unified5hReset = null;
    }
    if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
      console.log(`[NextClaude] Account "${account.name}" weekly quota reset`);
      q.unified7d = null;
      q.unified7dReset = null;
      q.unifiedStatus = null;
    }
    if (q.resetsAt && now >= new Date(q.resetsAt).getTime()) {
      q.tokensRemaining = null;
      q.tokensLimit = null;
      q.requestsRemaining = null;
      q.requestsLimit = null;
      q.resetsAt = null;
    }
  }

  /** Soft signal: account has crossed switchThreshold and is switch-eligible. */
  _inWarningZone(account) {
    this._clearExpiredQuotas(account);
    return this._utilization(account) >= this.switchThreshold;
  }

  /**
   * Hard backstop: switch NOW regardless of context. True on an explicit
   * 'rejected' rate-limit status or once utilization reaches hardThreshold.
   */
  _mustSwitch(account) {
    if (account.quota.unifiedStatus === 'rejected') return true;
    return this._utilization(account) >= this.hardThreshold;
  }

  _selectNext() {
    // Lever B: pick the account with the most remaining quota rather than the
    // next one round-robin (which could land on an almost-full account and
    // force another rebuild moments later).
    const next = this._selectBest();
    if (next) {
      this.currentIndex = next.index;
      console.log(`[NextClaude] Switched to account "${next.name}"`);
      return next;
    }
    return this._selectSoonestReset();
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex, headers) {
    const account = this.accounts[accountIndex];
    if (!account) return;

    // Unified rate limits (Claude Max)
    const u5h = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
    const u7d = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
    if (!isNaN(u5h)) account.quota.unified5h = u5h;
    if (!isNaN(u7d)) account.quota.unified7d = u7d;

    const r5h = headers['anthropic-ratelimit-unified-5h-reset'];
    const r7d = headers['anthropic-ratelimit-unified-7d-reset'];
    if (r5h) account.quota.unified5hReset = parseInt(r5h, 10) * 1000;
    if (r7d) account.quota.unified7dReset = parseInt(r7d, 10) * 1000;

    const uStatus = headers['anthropic-ratelimit-unified-status'];
    if (uStatus) account.quota.unifiedStatus = uStatus;

    // Standard rate limits (API key accounts)
    const tokensLimit = parseInt(headers['anthropic-ratelimit-tokens-limit'], 10);
    const tokensRemaining = parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10);
    const tokensReset = headers['anthropic-ratelimit-tokens-reset'];
    const requestsLimit = parseInt(headers['anthropic-ratelimit-requests-limit'], 10);
    const requestsRemaining = parseInt(headers['anthropic-ratelimit-requests-remaining'], 10);
    const requestsReset = headers['anthropic-ratelimit-requests-reset'];

    if (!isNaN(tokensLimit)) account.quota.tokensLimit = tokensLimit;
    if (!isNaN(tokensRemaining)) account.quota.tokensRemaining = tokensRemaining;
    if (!isNaN(requestsLimit)) account.quota.requestsLimit = requestsLimit;
    if (!isNaN(requestsRemaining)) account.quota.requestsRemaining = requestsRemaining;

    if (tokensReset) account.quota.resetsAt = tokensReset;
    else if (requestsReset) account.quota.resetsAt = requestsReset;

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when entering the warning zone (armed for a compaction-timed switch)
    if (this._inWarningZone(account)) {
      const pct = (this._utilization(account) * 100).toFixed(1);
      const note = this._mustSwitch(account) ? 'at hard limit — switching now' : 'armed — will switch at next compaction or hard limit';
      console.log(`[NextClaude] Account "${account.name}" at ${pct}% usage — ${note}`);
    }
  }

  /**
   * Update cumulative token usage from response body data.
   * cacheCreation/cacheRead come from the Anthropic usage object and let us
   * see (and later, in Layer 2, time switches against) the real rebuild cost.
   */
  updateUsage(accountIndex, inputTokens, outputTokens, cacheCreation = 0, cacheRead = 0) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    const u = account.usage;
    if (inputTokens) u.totalInputTokens += inputTokens;
    if (outputTokens) u.totalOutputTokens += outputTokens;
    if (cacheCreation) {
      u.totalCacheCreationTokens += cacheCreation;
      u.lastCacheCreationTokens = cacheCreation;
      // A large cache_creation with little/no cache_read is a cold rebuild —
      // i.e. this request landed on an org that didn't hold the prefix.
      if (cacheCreation > 0 && (!cacheRead || cacheCreation > cacheRead)) {
        u.totalSwitchRebuilds++;
      }
    }
    if (cacheRead != null) u.lastCacheReadTokens = cacheRead;
    if (cacheRead) u.totalCacheReadTokens += cacheRead;
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfterSeconds * 1000);
    console.log(`[NextClaude] Account "${account.name}" rate limited for ${retryAfterSeconds}s`);
  }

  /**
   * Ensure an OAuth account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth' || !account.refreshToken) return;

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      console.log(`[NextClaude] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await refreshAccessToken(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        console.log(`[NextClaude] Token refreshed for account "${account.name}"`);
        this._onTokenRefresh?.(accountIndex, newTokens);
      } catch (err) {
        console.error(`[NextClaude] Token refresh failed for "${account.name}": ${err.message}`);
        // Only mark as error if the access token is actually expired;
        // a failed proactive refresh shouldn't kill a still-valid token
        if (!account.expiresAt || Date.now() >= account.expiresAt) {
          account.status = 'error';
        }
      } finally {
        account._refreshPromise = null;
      }
    })();

    return account._refreshPromise;
  }

  /**
   * Set a callback to persist refreshed tokens to config.
   */
  onTokenRefresh(callback) {
    this._onTokenRefresh = callback;
  }

  /**
   * Update a specific account's OAuth tokens (e.g. after intercepting a token refresh).
   */
  updateAccountTokens(accountIndex, { accessToken, refreshToken, expiresAt }) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth') return;

    account.credential = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
    if (account.status === 'error') account.status = 'active';
    console.log(`[NextClaude] Updated tokens for account "${account.name}"`);
    this._onTokenRefresh?.(accountIndex, {
      accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    });
  }

  /**
   * Add a new account at runtime.
   */
  addAccount(acctData) {
    const index = this.accounts.length;
    this.accounts.push({
      index,
      name: acctData.name,
      type: acctData.type,
      accountUuid: acctData.accountUuid || null,
      credential: acctData.accessToken || acctData.apiKey,
      refreshToken: acctData.refreshToken || null,
      expiresAt: acctData.expiresAt || null,
      status: 'active',
      quota: emptyQuota(),
      usage: emptyUsage(),
      rateLimitedUntil: null,
    });
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => a.index = i);
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1);
    } else if (this.currentIndex > index) {
      this.currentIndex--;
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      activeSessions: this.sessions.size,
      accounts: this.accounts.map(a => ({
        name: a.name,
        type: a.type,
        status: a.status,
        quota: { ...a.quota },
        usage: { ...a.usage },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
    };
  }
}
