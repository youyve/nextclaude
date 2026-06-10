import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

/**
 * Derive a stable per-conversation key from the request body so the proxy can
 * pin a conversation to one account (Layer 1 affinity). We hash only the STABLE
 * prefix — model + system prompt + tool definitions + the first message — which
 * does not change as the conversation grows, so every turn of one conversation
 * maps to the same key. Hashing the growing message tail instead would re-key
 * every turn and defeat affinity. Returns null for non-JSON or non-chat bodies,
 * in which case the caller falls back to global routing.
 */
export function deriveSessionKey(body) {
  if (!body || body.length === 0) return null;
  try {
    const j = JSON.parse(body.toString());
    if (!j || !Array.isArray(j.messages) || j.messages.length === 0) return null;
    const h = createHash('sha256');
    h.update(j.model || '');
    h.update('\0');
    h.update(typeof j.system === 'string' ? j.system : JSON.stringify(j.system || ''));
    h.update('\0');
    h.update(JSON.stringify((j.tools || []).map(t => t?.name)));
    h.update('\0');
    h.update(JSON.stringify(j.messages[0]));
    return h.digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

export function createProxyServer(accountManager, config, hooks = {}) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  let requestCounter = 0;

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Auth check — skip for localhost connections
      const clientKey = req.headers['x-api-key'];
      const remoteAddr = req.socket.remoteAddress;
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      if (proxyApiKey && clientKey !== proxyApiKey && !isLocal) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        }));
        return;
      }

      // Status endpoint
      if (req.method === 'GET' && req.url === '/nextclaude/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(accountManager.getStatus(), null, 2));
        return;
      }

      // Let client token refresh requests pass through to upstream untouched.
      // The proxy manages its own tokens via ensureTokenFresh(); intercepting
      // or rewriting client refreshes would cause token rotation conflicts.
      if (req.method === 'POST' && req.url === '/v1/oauth/token') {
        await relayRaw(req, res, upstream);
        return;
      }

      // Track request
      const reqId = ++requestCounter;
      hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

      // Buffer request body (needed for retry on 429)
      const bodyChunks = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk);
      }
      const body = Buffer.concat(bodyChunks);

      // Compute the session key once here (not inside the retry recursion) so
      // every retry of this request routes to the same pinned account.
      const sessionKey = deriveSessionKey(body);

      const ctx = { account: null, status: null, usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 } };
      try {
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir, sessionKey);
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error('[NextClaude] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'proxy_error', message: 'Internal proxy error' },
          }));
        }
      } finally {
        hooks.onRequestEnd?.(reqId, {
          method: req.method, path: req.url,
          account: ctx.account, status: ctx.status, usage: ctx.usage,
        });
      }
    } catch (err) {
      console.error('[NextClaude] Unhandled error:', err);
    }
  });

  return server;
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 */
async function relayRaw(req, res, upstream) {
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);

  try {
    const upstreamRes = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'user-agent': req.headers['user-agent'] || 'node',
      },
      body: body.length > 0 ? body : undefined,
    });

    const responseBody = await upstreamRes.text();
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    res.end(responseBody);
  } catch (err) {
    console.error('[NextClaude] Raw relay error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  }
}


function logTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

async function writeRequestLog(logDir, reqId, sections) {
  if (!logDir) return;
  const ts = logTimestamp();
  const filename = `${ts}_${String(reqId).padStart(5, '0')}.log`;
  try {
    await writeFile(join(logDir, filename), sections.join('\n\n'), 'utf-8');
  } catch (err) {
    console.error(`[NextClaude] Failed to write log: ${err.message}`);
  }
}

function formatHeaders(headers) {
  if (headers.entries) {
    return [...headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

/** User-facing message when every account is over quota (no real seconds — the
 * SDK ignores retry-after >= 60s, and the probe handles early recovery). */
function allExhaustedMessage(n) {
  return `All ${n} account(s) are at their usage limit. NextClaude probes for early recovery on each retry and resumes automatically as soon as any account frees up — just resend if your turn ends first.`;
}

/** Build upstream request headers from the client's, swapping in this account's
 * credential. Shared by the normal forward path and the speculative probe so
 * they can never drift. */
function buildUpstreamHeaders(reqHeaders, account) {
  const headers = {};
  for (const [key, value] of Object.entries(reqHeaders)) {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk)) continue;
    if (lk === 'x-api-key') continue;
    // Strip accept-encoding: Node fetch auto-decompresses, which would
    // mismatch the Content-Encoding header we forward to the client
    if (lk === 'accept-encoding') continue;
    headers[key] = value;
  }
  if (account.type === 'oauth') {
    headers['authorization'] = `Bearer ${account.credential}`;
  } else {
    headers['x-api-key'] = account.credential;
  }
  return headers;
}

/**
 * Relay a successful upstream response to the client: copy headers, stream (SSE)
 * or buffer the body, capture per-request usage, and attribute it to the serving
 * account. Shared by the normal forward path and the speculative-probe path.
 */
async function sendUpstreamResponse(upstreamRes, res, accountManager, accountIndex, ctx, logDir, reqId, logSections) {
  if (logDir) {
    logSections.push(`=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);
  }

  ctx.status = upstreamRes.status;

  // Build response headers (skip hop-by-hop and encoding headers)
  const responseHeaders = {};
  for (const [key, value] of upstreamRes.headers.entries()) {
    if (key === 'transfer-encoding' || key === 'connection') continue;
    // Strip content-encoding/content-length since fetch may auto-decompress
    if (key === 'content-encoding' || key === 'content-length') continue;
    responseHeaders[key] = value;
  }

  res.writeHead(upstreamRes.status, responseHeaders);

  if (!upstreamRes.body) {
    if (logDir) {
      logSections.push(`=== RESPONSE BODY ===\n(empty)`);
      writeRequestLog(logDir, reqId, logSections);
    }
    res.end();
    return;
  }

  const isStreaming = (upstreamRes.headers.get('content-type') || '').includes('text/event-stream');

  if (isStreaming) {
    const streamLog = logDir ? [] : null;
    await streamResponse(upstreamRes.body, res, ctx.usage, streamLog);
    accountManager.updateUsage(accountIndex, ctx.usage.input, ctx.usage.output, ctx.usage.cacheCreation, ctx.usage.cacheRead);
    if (logDir) {
      logSections.push(`=== RESPONSE BODY (streamed) ===\n${streamLog.join('')}`);
      writeRequestLog(logDir, reqId, logSections);
    }
  } else {
    const buf = Buffer.from(await upstreamRes.arrayBuffer());
    extractUsageFromBody(buf, ctx.usage);
    accountManager.updateUsage(accountIndex, ctx.usage.input, ctx.usage.output, ctx.usage.cacheCreation, ctx.usage.cacheRead);
    if (logDir) {
      try {
        logSections.push(`=== RESPONSE BODY ===\n${JSON.stringify(JSON.parse(buf.toString()), null, 2)}`);
      } catch {
        logSections.push(`=== RESPONSE BODY (${buf.length} bytes) ===\n${buf.toString().slice(0, 8192)}`);
      }
      writeRequestLog(logDir, reqId, logSections);
    }
    res.end(buf);
  }
}

/**
 * Speculatively probe the soonest-resetting account with the REAL buffered
 * request when everything looks exhausted. Returns true iff it served the
 * client (early recovery found); false means the caller should fall through to
 * the 429. Throttle + in-flight are claimed synchronously by beginProbe BEFORE
 * the fetch await, so a concurrent request can never launch a second probe.
 */
async function tryProbeRecovery(req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir) {
  const candidate = accountManager.getProbeCandidate();
  if (!candidate || !accountManager.beginProbe(candidate.index)) return false;

  let upstreamRes = null;
  try {
    await accountManager.ensureTokenFresh(candidate.index);
    if (candidate.status === 'error') return false;

    const headers = buildUpstreamHeaders(req.headers, candidate);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), accountManager._probeTimeoutMs);
    try {
      upstreamRes = await fetch(`${upstream}${req.url}`, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
        redirect: 'manual',
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Fold the probe's rate-limit headers into our quota tracking either way.
    const rl = {};
    for (const [k, v] of upstreamRes.headers.entries()) {
      if (k.startsWith('anthropic-ratelimit-')) rl[k] = v;
    }
    accountManager.updateQuota(candidate.index, rl);

    if (upstreamRes.status === 429) {
      // Still genuinely over quota — record it and let the caller 429 the client.
      await upstreamRes.body?.cancel();
      const ra = parseInt(upstreamRes.headers.get('retry-after'), 10) || 60;
      accountManager.markRateLimited(candidate.index, ra);
      return false;
    }
  } catch (err) {
    // Abort (timeout) or network error — fall through to the 429.
    console.error(`[NextClaude] Probe failed on "${candidate.name}": ${err.message}`);
    if (upstreamRes) { try { await upstreamRes.body?.cancel(); } catch {} }
    return false;
  } finally {
    accountManager.endProbe();
  }

  if (res.destroyed) return true; // client gave up; nothing to send, but don't 429

  // Early recovery confirmed. Reactivate the account so later requests route
  // normally (a 2xx carries no unified-status header, so the stale 'rejected'
  // would otherwise force every request back through the throttled probe).
  accountManager.markRecovered(candidate.index);
  ctx.account = candidate.name;
  hooks.onRequestRouted?.(reqId, { account: candidate.name });
  console.log(`[NextClaude] Probe found early recovery on "${candidate.name}" — serving this request`);

  const logSections = logDir ? [`=== PROBE SERVED (account: ${candidate.name}) ===`] : null;
  try {
    await sendUpstreamResponse(upstreamRes, res, accountManager, candidate.index, ctx, logDir, reqId, logSections);
  } catch (err) {
    console.error(`[NextClaude] Probe relay error on "${candidate.name}": ${err.message}`);
    if (res.headersSent) { res.destroy(); return true; }
    return false; // headers not sent yet — let the caller emit the 429
  }
  return true;
}

async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sessionKey = null) {
  const maxRetries = accountManager.accounts.length;

  // Select account — sessionKey pins this conversation to its warm account.
  // body.length is a free, accurate proxy for context size: Claude Code resends
  // the full history every turn, so a sharp drop marks a client auto-compaction.
  const account = accountManager.getActiveAccount(sessionKey, body.length);
  if (!account) {
    // Every account looks exhausted from our cached quota. Before giving up,
    // send ONE throttled speculative probe (the real request) to the soonest-
    // resetting account: the unified 5h limit is a rolling window that can free
    // up before its advertised reset, and only an upstream attempt can tell.
    // Gate on retryCount===0 so we only probe on a FRESH request (where nothing
    // was available on arrival) — never inside the retry recursion, where we
    // just tried real accounts and already got 429s this turn.
    if (retryCount === 0 &&
        await tryProbeRecovery(req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir)) {
      return;
    }
    ctx.status = 429;
    ctx.account = '(none available)';
    const status = accountManager.getStatus();
    const retryAfter = computeRetryAfter(status.accounts);
    if (!res.headersSent) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'retry-after': String(retryAfter),
      });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: allExhaustedMessage(accountManager.accounts.length),
        },
      }));
    }
    return;
  }

  // Track which account handles this request
  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // Refresh OAuth token if needed
  await accountManager.ensureTokenFresh(account.index);
  if (account.status === 'error' && retryCount < maxRetries) {
    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sessionKey);
  }

  // Build upstream request headers
  const headers = buildUpstreamHeaders(req.headers, account);

  const upstreamUrl = `${upstream}${req.url}`;
  const method = req.method;

  // Build log sections
  const logSections = [];
  if (logDir) {
    const safeHeaders = { ...headers };
    // Mask credentials in logs
    if (safeHeaders['x-api-key']) {
      safeHeaders['x-api-key'] = safeHeaders['x-api-key'].slice(0, 15) + '...';
    }
    if (safeHeaders['authorization']) {
      safeHeaders['authorization'] = safeHeaders['authorization'].slice(0, 20) + '...';
    }
    logSections.push(
      `=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(safeHeaders)}`,
    );
    if (body.length > 0) {
      try {
        logSections.push(`=== REQUEST BODY ===\n${JSON.stringify(JSON.parse(body.toString()), null, 2)}`);
      } catch {
        logSections.push(`=== REQUEST BODY (${body.length} bytes) ===\n${body.toString().slice(0, 4096)}`);
      }
    }
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      redirect: 'manual',
    });

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) {
        rateLimitHeaders[key] = value;
      }
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

    if (upstreamRes.status === 429) {
      const retryAfter = parseInt(upstreamRes.headers.get('retry-after'), 10) || 60;
      // Discard the 429 response body
      await upstreamRes.body?.cancel();

      // updateQuota() above already folded this 429's rate-limit headers in, so
      // we can tell genuine quota exhaustion ('rejected' / at-ceiling) from a
      // transient burst limit.
      if (accountManager.isQuotaRejection(account.index)) {
        accountManager.markRateLimited(account.index, retryAfter);
        if (retryCount < maxRetries) {
          if (logDir) logSections.push(`=== RESPONSE 429 (quota) — switching account ===\n${formatHeaders(upstreamRes.headers)}`);
          console.log(`[NextClaude] 429 quota-exhausted on "${account.name}" — switching account`);
          return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sessionKey);
        }
        // Every account is quota-exhausted. Return a 429 to the client NOW with
        // the real time-to-reset instead of holding the connection open — the
        // old code waited retry-after (often hours), which looked to Claude Code
        // like an endless "cooking" spinner that never recovered.
        ctx.status = 429;
        const ra = computeRetryAfter(accountManager.getStatus().accounts);
        console.log(`[NextClaude] All accounts quota-exhausted — returning 429 (retry in ${ra}s)`);
        if (logDir) { logSections.push(`=== RESPONSE 429 (all exhausted, retry ${ra}s) ===`); writeRequestLog(logDir, reqId, logSections); }
        if (!res.headersSent) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(ra) });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: allExhaustedMessage(accountManager.accounts.length) },
          }));
        }
        return;
      }

      // Transient burst limit: short, bounded wait then retry the SAME warm
      // account. Cap the wait and the number of retries so a request is never
      // held open indefinitely.
      if (retryCount < maxRetries) {
        const wait = Math.min(retryAfter, 60);
        if (logDir) logSections.push(`=== RESPONSE 429 (transient) — waiting ${wait}s ===\n${formatHeaders(upstreamRes.headers)}`);
        console.log(`[NextClaude] 429 (transient) on "${account.name}" — waiting ${wait}s before retry`);
        await new Promise(resolve => setTimeout(resolve, wait * 1000));
        if (res.destroyed) return;
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sessionKey);
      }
      ctx.status = 429;
      if (logDir) { logSections.push(`=== RESPONSE 429 (transient, retries exhausted) ===`); writeRequestLog(logDir, reqId, logSections); }
      if (!res.headersSent) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(Math.min(retryAfter, 60)) });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited, please retry.' } }));
      }
      return;
    }

    await sendUpstreamResponse(upstreamRes, res, accountManager, account.index, ctx, logDir, reqId, logSections);
  } catch (err) {
    console.error(`[NextClaude] Upstream error (account "${account.name}"):`, err.message);

    if (logDir) {
      logSections.push(`=== ERROR ===\n${err.stack || err.message}`);
      writeRequestLog(logDir, reqId, logSections);
    }

    const isTransient = err instanceof Error &&
      (err.message.includes('fetch failed') ||
        err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT');

    // Transient network errors: just close the connection and let the client retry
    if (isTransient) {
      res.destroy();
      return;
    }

    if (retryCount < maxRetries && !res.headersSent) {
      account.status = 'error';
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sessionKey);
    }
    ctx.status = 502;

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'proxy_error', message: `Upstream error: ${err.message}` },
      }));
    }
  }
}

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
async function streamResponse(webStream, res, usage, streamLog) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Client disconnected — stop reading from upstream
      if (res.destroyed) break;

      // Forward chunk immediately
      const ok = res.write(value);

      const text = decoder.decode(value, { stream: true });

      // Capture for logging
      if (streamLog) streamLog.push(text);

      // Parse SSE events for usage tracking
      sseBuffer += text;
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop(); // keep incomplete event

      for (const event of events) {
        parseSSEUsage(event, usage);
      }

      // Handle backpressure — also bail out if client disconnects,
      // because 'drain' will never fire on a destroyed socket
      if (!ok) {
        await new Promise(resolve => {
          res.once('drain', resolve);
          res.once('close', resolve);
        });
        if (res.destroyed) break;
      }
    }

    // Parse any remaining buffer
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, usage);
    }
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

function parseSSEUsage(event, usage) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message?.usage) {
      const u = data.message.usage;
      usage.input += u.input_tokens || 0;
      usage.cacheCreation += u.cache_creation_input_tokens || 0;
      usage.cacheRead += u.cache_read_input_tokens || 0;
      if (u.output_tokens) usage.output = Math.max(usage.output, u.output_tokens);
    } else if (data.type === 'message_delta' && data.usage) {
      // output_tokens here is cumulative for the message — take the max, don't sum.
      usage.output = Math.max(usage.output, data.usage.output_tokens || 0);
    }
  } catch {
    // not valid JSON, skip
  }
}

function extractUsageFromBody(buffer, usage) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      usage.input += json.usage.input_tokens || 0;
      usage.output = Math.max(usage.output, json.usage.output_tokens || 0);
      usage.cacheCreation += json.usage.cache_creation_input_tokens || 0;
      usage.cacheRead += json.usage.cache_read_input_tokens || 0;
    }
  } catch {
    // not JSON or no usage
  }
}

export function computeRetryAfter(accounts) {
  let soonest = Infinity;
  const consider = (ms) => {
    if (ms == null) return;
    const d = ms - Date.now();
    if (d > 0 && d < soonest) soonest = d;
  };
  for (const acct of accounts) {
    if (acct.rateLimitedUntil) consider(new Date(acct.rateLimitedUntil).getTime());
    const q = acct.quota || {};
    consider(q.unified5hReset);          // ms timestamps
    consider(q.unified7dReset);
    if (q.resetsAt) consider(new Date(q.resetsAt).getTime());
  }
  // Cap below the Anthropic SDK's retry-after honor threshold. Claude Code's
  // client IGNORES a retry-after >= 60s (it falls back to short exponential
  // backoff), so a raw multi-hour value is both useless to the client and
  // misleading to the user. Keeping it < 60s means the SDK actually honors the
  // header for its internal retries; real recovery is delivered by the probe.
  const MAX_RETRY_AFTER_S = 55;
  const secs = soonest === Infinity ? MAX_RETRY_AFTER_S : Math.ceil(soonest / 1000);
  return Math.max(1, Math.min(MAX_RETRY_AFTER_S, secs));
}
