# NextClaude

Multi-account Claude proxy with automatic quota-based rotation for [Claude Code](https://claude.ai/claude-code).

Sits transparently between Claude Code and the Anthropic API, managing multiple Claude Max (or API key) accounts and automatically switching when one approaches its session or weekly quota limit.

![NextClaude TUI](screenshots/nextclaude.png)

## Features

- **Token-aware account rotation** — switches accounts when session (5h) or weekly (7d) quota runs out, while minimizing the prompt-cache rebuilds that switching otherwise costs (see [Minimizing switch cost](#minimizing-switch-cost))
- **Session affinity** — pins each conversation to one account and never switches it back to a cache-cold account, so its prompt cache keeps hitting `cache_read` instead of being re-billed as `cache_creation`
- **Compaction-aware switching** — defers an unavoidable switch and lands it right after the client auto-compacts, so the cold rebuild copies a small post-compaction prefix instead of the full context
- **Auto-retry on 429** — distinguishes a transient burst limit (waits `retry-after`, retries the same account) from quota exhaustion (switches accounts)
- **Interactive TUI** — real-time dashboard with color-coded quota bars, reset countdowns, activity log, and keyboard controls
- **OAuth token management** — automatically refreshes tokens nearing expiry and persists them to config; client token refreshes pass through untouched
- **Hot-reload accounts** — add accounts via `import` or `login` while the server is running, press **R** to pick them up
- **Account deduplication** — detects duplicate accounts by UUID and keeps the most recent
- **Request logging** — optional full request/response logging for debugging
- **Zero dependencies** — uses only Node.js built-in modules

## Quick Start

Requires Node.js 18+.

```bash
# Install from GitHub
npm install -g github:youyve/nextclaude

# …or clone and install locally
git clone https://github.com/youyve/nextclaude.git
cd nextclaude && npm install -g .

# Add your first account (opens browser for OAuth)
nextclaude login

# Add a second account
nextclaude login

# Start the proxy
nextclaude server

# In another terminal, run Claude Code through the proxy
nextclaude run
```

You can also import existing Claude Code credentials instead of logging in:

```bash
claude /login           # Log into an account in Claude Code
nextclaude import       # Import its credentials
```

## Adding Accounts

### OAuth Login (recommended)

The easiest way to add accounts — opens your browser for authentication:

```bash
nextclaude login
```

Uses the same OAuth flow as Claude Code. Auto-detects the account email and subscription tier. Logging in with the same account again updates its credentials.

You can add accounts while the server is running — press **R** in the TUI to reload.

### Import from Claude Code

If you already have Claude Code set up, you can import its credentials directly:

```bash
claude /login           # Log into an account in Claude Code
nextclaude import       # Import its credentials
```

Re-importing the same account updates its credentials. You can also import from a custom path:

```bash
nextclaude import --from /path/to/credentials.json
```

### API Key

For Anthropic API key accounts (billed via Console):

```bash
nextclaude login --api
```

## Usage

### Start the proxy server

```bash
nextclaude server
```

When running from a TTY, shows an interactive TUI with:
- Account table with session/weekly quota progress bars and reset countdowns
- Real-time activity log with request tracking
- Keyboard shortcuts (see below)

Falls back to plain log output when not a TTY (e.g. running as a service).

#### TUI Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `s` | Switch active account |
| `a` | Add account (import or API key) |
| `r` | Remove an account |
| `R` | Reload accounts from config |
| `q` | Quit |

In selection mode, use `j`/`k` or arrow keys to navigate, `Enter` to confirm, `Esc` to cancel.

### Run Claude Code through the proxy

```bash
nextclaude run
```

Or manually set the environment:

```bash
eval $(nextclaude env)
claude
```

### Other commands

```bash
nextclaude accounts          # List accounts with subscription tier and token status
nextclaude accounts -v       # Also show token expiry times
nextclaude status            # Show live proxy status (requires running server)
nextclaude remove <name>     # Remove an account
nextclaude api <path>        # Call an API endpoint with account credentials
nextclaude help              # Show all commands
```

### Request logging

Log full request/response details to a directory (one file per request):

```bash
nextclaude server --log-to /tmp/requests
```

## Configuration

Config is stored at `~/.config/nextclaude.json` (or `$XDG_CONFIG_HOME/nextclaude.json`). A random proxy API key is generated on first use.

Override the config path with `NEXTCLAUDE_CONFIG`:

```bash
NEXTCLAUDE_CONFIG=./my-config.json nextclaude server
```

### Config format

```json
{
  "proxy": {
    "port": 3456,
    "apiKey": "nc-auto-generated-key"
  },
  "upstream": "https://api.anthropic.com",
  "switchThreshold": 0.98,
  "accounts": [
    {
      "name": "user@example.com",
      "type": "oauth",
      "accountUuid": "...",
      "accessToken": "sk-ant-oat01-...",
      "refreshToken": "sk-ant-ort01-...",
      "expiresAt": 1774384968427
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `proxy.port` | Local port the proxy listens on |
| `proxy.apiKey` | API key clients use to authenticate with the proxy |
| `upstream` | Upstream API base URL |
| `switchThreshold` | Soft quota utilization (0–1) that *arms* a switch; the proxy then waits for a cheap moment to actually switch (default 0.98) |

## How It Works

1. Claude Code connects to the local proxy instead of `api.anthropic.com`
2. The proxy derives a stable session key from each request and pins that conversation to one account, forwarding with that account's credentials
3. OAuth tokens expiring within 5 minutes are automatically refreshed and persisted to config
4. Rate limit headers from the API (`anthropic-ratelimit-unified-*`) track session (5h) and weekly (7d) quota utilization
5. When the pinned account is exhausted the proxy switches **forward only** — to the account with the most remaining quota — and never returns to it (its cache is cold), so the realized number of rebuilds stays at the minimum
6. On 429 responses, a transient burst limit waits `retry-after` and retries the same account; a quota rejection switches accounts
7. Transient network errors (connection reset, timeout) drop the connection so the client can retry
8. If all accounts are exhausted, returns 429 with the soonest reset time
9. Client token refresh requests (`/v1/oauth/token`) are relayed to upstream untouched — the proxy and client manage their own token lifecycles independently

## Minimizing switch cost

Anthropic's prompt cache is isolated per account, so switching accounts forces the new account to re-bill the whole cached prefix as `cache_creation` (~1.25× input price, fully counted against the new account's quota) instead of the cheap `cache_read` (~0.1×). For a task that spans *N* accounts' quota this is unavoidable **N−1** times — but no more, and each one can be made small:

- **Hold the count at N−1.** Session affinity + forward-only switching mean a conversation never bounces between accounts or returns to a cold one. (This also fixes a latent bug where, with multiple concurrent conversations, a single global cursor let them flip each other's account and trigger cold rebuilds.)
- **Shrink each rebuild.** When the pinned account crosses `switchThreshold` the switch is *armed* but deferred; the proxy watches request size and performs the switch right after the client's own auto-compaction (a sharp size drop), so the cold rebuild copies the small post-compaction prefix. A hard ceiling (utilization ≥ 0.995 or a `rejected` status) forces the switch regardless, so deferral is never worse than switching eagerly and never causes a visible rejection.
- The proxy never rewrites request bodies, never pre-warms standby accounts, and never injects long cache TTLs — each of those either corrupts the conversation or just moves the token cost around rather than removing it.

`nextclaude status` reports per-account `cache_creation` / `cache_read` totals and a cold-rebuild count so you can see the effect.

## License

MIT
