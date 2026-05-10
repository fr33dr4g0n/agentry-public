# Agentry — Build Status

**Last updated:** 2026-05-10 (GitHub OAuth landed)
**Phase:** ✅ v0 working end-to-end with GitHub device-flow auth. Awaiting your sanity check.

## Quickstart for the human (you, when you're back)

You have two paths. **Path A is the fastest** — try it first.

### Path A: try the MCP locally (no Cloudflare deploy needed)

The API is already running locally on `wrangler dev` against your real Turso database. The schema is pushed. To use it, just install the MCP into Claude Code and start chatting.

```bash
# 1. Make sure the local API is up. If not, start it:
cd /Users/henrikh/Documents/code/agentry/apps/api
npx wrangler dev --port 8787 --local

# 2. In ANOTHER terminal: install the MCP into your Claude Code, pointing at local API:
AGENTRY_SERVER_URL=http://127.0.0.1:8787 claude mcp add agentry --scope user -- node /Users/henrikh/Documents/code/agentry/packages/mcp/dist/index.js

# 3. Open Claude Code in any project (e.g. musicvideogenerator) and just say:
#    "set me up with agentry, my email is harjuhenrik@gmail.com"
#
# The agent will walk through:
#   agentry_status → "you have no key, ask user for email"
#   agentry_signup → mints API key, stored in ~/.agentry/config.json
#   agentry_create_project → returns DSN + install snippet
#   agentry_capture_test_event → fires a synthetic event
#   agentry_list_cases → shows it landed
```

### Path B: deploy to Cloudflare (3 commands once)

```bash
cd /Users/henrikh/Documents/code/agentry/apps/api

# 1. One-time login
npx wrangler login

# 2. Set production secrets (paste these — they're already in .dev.vars locally)
npx wrangler secret put TURSO_DATABASE_URL    # libsql://agentry-hexa.aws-us-west-2.turso.io
npx wrangler secret put TURSO_AUTH_TOKEN      # (the long token you gave me)
npx wrangler secret put GITHUB_CLIENT_ID      # Ov23li3FBmbKhlhBgRMU
npx wrangler secret put GITHUB_CLIENT_SECRET  # c6e60b4b2ebd26a1d3f12aad2078cd74f6b52eae
# DO NOT set ENABLE_TEST_LOGIN in prod — it's the local test-only backdoor.

# 3. Deploy
npx wrangler deploy
# → outputs https://agentry-api.<your-subdomain>.workers.dev

# 4. Point your MCP at the deployed URL:
AGENTRY_SERVER_URL=https://agentry-api.<your-subdomain>.workers.dev claude mcp add agentry --scope user -- node /Users/henrikh/Documents/code/agentry/packages/mcp/dist/index.js
```

> ✅ **The deployed URL is now safe to share.** GitHub device flow vouches for every user — there's no open-signup endpoint.
> The only auth backdoor is `/v1/auth/_test/login`, gated behind `ENABLE_TEST_LOGIN=true`, which the prod secret store should never set.

## What got built

- **Cloudflare Workers API** (Hono + Drizzle + Turso): auth, projects, cases, ingest (Sentry-protocol-compatible), suppressions, discovery (`llms.txt`)
- **Turso schema** pushed and live (7 tables)
- **Node SDK** `@agentry/node` — three-line install, handles Error / non-Error / null / string / huge stacks / async stacks
- **MCP server** `@agentry/mcp` — 13 tools, conversational onboarding, persists config to `~/.agentry/config.json`
- **Tests**: 92 unit + integration tests, all green. 58 live e2e tests against `wrangler dev` + real Turso, all green. Dogfood test (SDK → ingest → case visible) passes.

```
agentry/
├── apps/api/                 Cloudflare Worker
├── packages/
│   ├── shared/               Frozen contract — schemas, fingerprint, errors, crypto, ids
│   ├── db/                   Drizzle schema + Turso client
│   ├── sdk-node/             @agentry/node
│   └── mcp/                  @agentry/mcp (the user-facing UX)
├── tests/e2e/
│   ├── live.mjs              Live e2e against wrangler dev
│   └── dogfood.mjs           SDK → API → case round-trip
├── PLAN.md                   Contract (start here if reading from cold)
├── STATUS.md                 ← you are here
├── CLAUDE.md                 Repo instructions for future Claude sessions
└── docs/decisions.md         Append-only log of design decisions
```

## What works (verified end-to-end)

- New user signs up via MCP → API key minted → persisted locally
- Same email re-signup mints fresh key (the v0 recovery path)
- API key rotation (`agentry_rotate_key`)
- Project creation returns DSN + ready-to-paste install snippet
- SDK captures Error / TypeError / SyntaxError / non-Error throws / strings / null
- Ingest handles Sentry-shape, X-Sentry-Auth header, ?sentry_key= query
- Same fingerprint dedupes into one case (event_count increments)
- Different fingerprint = different case
- Tenancy: user A cannot read user B's cases (403)
- Suppressions: pattern → auto_ignore returns 202 on subsequent matches
- Malformed JSON → 400 with `next_action` hint, never 500
- Huge stack (500 frames) → 200, no crash
- Unknown forward-compat fields → 200
- Body over 256 KB → 413 with structured error

## How the MCP onboarding actually feels

```
>>> agentry_status   (cold)
state: no_key
next_action: "Call agentry_login to authenticate via GitHub (no email or password required)"

>>> agentry_login    (mode: full — blocks until done)
returns:
  verification_uri: https://github.com/login/device
  user_code: WDJB-MJHT
... agent shows code to user, user authorizes ...
returns: { ok: true, user_id, github: { username, email }, api_key persisted }

>>> agentry_status   (after login)
state: no_project
next_action: "Ask the user for a project name, then call agentry_create_project"

>>> agentry_create_project   (my-app)
returns: { dsn, install_snippet (paste-ready), local_path }

>>> agentry_capture_test_event
returns: { case_id }, "Call agentry_get_case to see how it looks"
```

If the agent prefers to control the polling loop itself (e.g. show the code to the user and confirm before polling), call `agentry_login` with `mode: "start_only"` first, then `mode: "poll_once"` with the returned `device_code`.

## Known v0 limits (intentional, to be fixed before public launch)

These are flagged in [docs/decisions.md](./docs/decisions.md) and the implementation review:

1. **Race on first event for a fingerprint** — two concurrent ingest requests with the same fingerprint may both try to insert a new case row; one will hit the unique index and 500, the SDK will retry. Fix: `INSERT ... ON CONFLICT(...) DO UPDATE`. Rare in practice at v0 volume.
4. **Suppressions are substring-only** — regex was tempting but exposes ReDoS. Re-introduce when we can run patterns under a hard timeout (RE2 in workers, or syntax-restricted globs).
5. **No PII scrubbing on stored `request` / `extra` / `tags` / `user`** — defensive scrubbing of headers, cookies, secrets is deferred. The fields are accepted via `IngestEventSchema.passthrough()` and persisted as JSON. Add a scrubber before the DB write.
6. **`requireApiKey` writes `lastUsedAt` on every authed request** — should use `executionCtx.waitUntil()` to defer or skip if recently updated. Doubles DB writes today.
7. **`agentry_capture_test_event` requires the project to have been created via this MCP** (DSN is stored locally only). On a second machine, the user must recreate the project. Fix: add a DSN-rotation endpoint the MCP can call when local DSN is missing.
8. **Single Worker, no GitHub App, no PR creation** — the agent runs in the user's Claude Code, so PR creation happens via Claude's existing git tools. Add a GitHub App when we want headless / always-on triage.

## Test commands

```bash
cd /Users/henrikh/Documents/code/agentry

npm run build           # tsc -b across all packages
npm run typecheck       # type-check across all packages
npm run test            # unit + integration tests (vitest), 92 passing

# Live e2e (requires wrangler dev running on 8787):
node tests/e2e/live.mjs

# Dogfood: SDK → real API → verify case lands:
node tests/e2e/dogfood.mjs
```

## Files you'll want to look at first

- [PLAN.md](./PLAN.md) — full contract, design decisions, scope
- [docs/decisions.md](./docs/decisions.md) — append-only log
- [packages/mcp/src/tools.ts](packages/mcp/src/tools.ts) — the 13 MCP tools (the UX)
- [apps/api/src/routes/](apps/api/src/routes/) — auth, projects, cases, ingest, suppressions
- [packages/sdk-node/src/](packages/sdk-node/src/) — Node SDK
- [tests/e2e/dogfood.mjs](tests/e2e/dogfood.mjs) — the canonical "does it work" script

## When you're ready to validate

The fastest way to convince yourself this is real:

1. Make sure wrangler dev is running (Path A above)
2. `claude mcp add agentry ...` (the command above)
3. In musicvideogenerator: "set me up with agentry, email is harjuhenrik@gmail.com"
4. Throw a real error somewhere in the codebase, watch the case land
5. Ask Claude to fix it — see if the case + recent_events + local_path is enough context

If the answer is "yes I'd merge this PR" or "yes the diagnosis was right" — the product is real. If not, the gap is in the prompt template or the case detail surface, both fixable in the MCP layer.
