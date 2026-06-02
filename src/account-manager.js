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
  getActiveAccount(sessionKey = null) {
    if (!sessionKey) {
      const current = this.accounts[this.currentIndex];
      if (this._isAvailable(current)) return current;
      return this._selectNext();
    }

    let sess = this.sessions.get(sessionKey);
    if (!sess) {
      sess = { pinned: null, burned: new Set(), lastSeen: Date.now() };
      this.sessions.set(sessionKey, sess);
      this._evictSessions();
    }
    sess.lastSeen = Date.now();

    // Stay on the pinned account while it can still serve.
    const pinned = sess.pinned ? this._byIdentity(sess.pinned) : null;
    if (pinned && this._isAvailable(pinned)) {
      this.currentIndex = pinned.index;
      return pinned;
    }

    // Pinned account is exhausted/gone: burn it (never come back) and switch
    // forward to the available account with the most remaining quota.
    if (sess.pinned) sess.burned.add(sess.pinned);
    let next = this._selectBest(sess.burned);

    // All non-burned accounts are unavailable. Only now do we accept an
    // unavoidable rebuild on a reset account — clear the burn set and fall back
    // to the soonest-resetting account (preserves the terminal all-exhausted path).
    if (!next) {
      sess.burned.clear();
      next = this._selectBest() || this._selectSoonestReset();
    }

    if (next) {
      if (sess.pinned && sess.pinned !== this._identity(next)) {
        console.log(`[NextClaude] Session switched "${this._shortKey(sessionKey)}" → "${next.name}"`);
      }
      sess.pinned = this._identity(next);
      this.currentIndex = next.index;
    }
    return next;
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
    if (this._isNearQuota(account)) return false;

    return true;
  }

  _isNearQuota(account) {
    const q = account.quota;
    const now = Date.now();

    // Clear expired unified quotas
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

    // Clear expired standard quotas
    if (q.resetsAt && now >= new Date(q.resetsAt).getTime()) {
      q.tokensRemaining = null;
      q.tokensLimit = null;
      q.requestsRemaining = null;
      q.requestsLimit = null;
      q.resetsAt = null;
    }

    // Unified quotas (Claude Max) — utilization is already 0-1
    if (q.unified5h != null && q.unified5h >= this.switchThreshold) return true;
    if (q.unified7d != null && q.unified7d >= this.switchThreshold) return true;

    // Standard quotas (API key accounts)
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= this.switchThreshold) return true;
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= this.switchThreshold) return true;
    }

    return false;
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

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null
        ? (account.quota.unified7d * 100).toFixed(1)
        : account.quota.tokensLimit
          ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
          : '?';
      console.log(`[NextClaude] Account "${account.name}" at ${pct}% usage — will switch on next request`);
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
