# Agentry — Build Status

**Last updated:** 2026-05-10 (webhooks for "do X automatically when Y happens")
**Phase:** ✅ v0 working end-to-end with capture (server + client + any language) + agent-driven query (no dashboard) + post-install next-step menu + **signed webhooks** for automation (auto-fix-on-error, deploy regression alerts, weekly digests). PostHog gated on env vars.

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

- **Cloudflare Workers API** (Hono + Drizzle + Turso): GitHub-OAuth-device-flow auth, projects, cases, errors ingest (Sentry-protocol), deploys ingest, analytics ingest (PostHog passthrough), suppressions, comprehensive install guide endpoint, discovery (`llms.txt`). **CORS enabled on /v1/store/*, /v1/track/*, /v1/deploys/* for browser SDK access** (DSN-authenticated, ACAO=*, preflight cached 24h). Other endpoints intentionally reject browser origins.
- **Turso schema** — 9 tables (`users`, `api_keys`, `projects`, `events`, `cases`, `agent_runs`, `suppression_entries`, `deploys`, `posthog_projects`).
- **Node SDK** `@agentry/node` — `init()`, `capture()`, `track()`, `deploy()`, `flush()`, `close()`. Server-side: Node 18+, Bun, Workers (with care).
- **Browser SDK** `@agentry/browser` — `init()`, `capture()`, `track()`, `flush()`, `flushBeacon()`, `close()`. Auto-wires `window.error` + `window.unhandledrejection` listeners. Multi-format stack parser (V8 / Safari / Firefox). Persists `distinct_id` to `localStorage` for stable analytics. Uses `navigator.sendBeacon` on `visibilitychange='hidden'` so events survive page unload. Pure ESM, zero runtime deps.
- **MCP server** `@agentry/mcp` — 18 tools. `agentry_install_guide` is framework-aware: `node` / `next` / `express` for server, `browser` / `react` / `next-client` for client. `agentry_verify_install` confirms each signal type actually reached agentry.
- **PostHog multi-tenant integration** — auto-provisions one PostHog project per agentry user (gated on `POSTHOG_HOST` + `POSTHOG_ORG_ID` + `POSTHOG_MASTER_API_KEY` + `AGENTRY_TOKEN_ENC_KEY` env vars; activates without code changes once you set them).
- **Tests**: 121 unit + integration green (40 API, 11 MCP, 17 browser SDK, 25 Node SDK, 28 shared). 89 live e2e green (errors, analytics, deploys, install guide for both server and client targets, CORS preflights, browser-origin POSTs). Dogfood passes end-to-end.

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

## Automation via webhooks

Three event types fire signed POSTs at customer-controlled URLs:

| event | when |
|---|---|
| `case.created` | first event of a new fingerprint lands |
| `case.resolved` | a case status flips to `resolved` |
| `deploy.recorded` | a deploy event is captured |

```
POST <your-url>
  X-Agentry-Signature: t=1736500000,v1=<hex>
  body: {"event":"case.created","delivered_at":...,"project_id":...,"data":{...}}
```

Verify with HMAC-SHA256(rawBody, signing_secret). The signing secret is shown once at registration. Signing secrets are encrypted at rest with `AGENTRY_TOKEN_ENC_KEY`.

The MCP exposes `agentry_register_webhook`, `agentry_list_webhooks`, `agentry_test_webhook`, `agentry_delete_webhook`, and `agentry_automation_docs` (which returns paste-ready Cloudflare Worker templates for auto-fix-on-error, deploy regression alerts, etc.).

## No dashboard — the agent IS the dashboard

The user asks a natural-language question; the agent runs a recipe; the answer appears in chat as a markdown table or ASCII chart.

```
User: "show me the signup funnel drop-off"
Agent: agentry_list_recipes(category: "funnels")
      → finds funnel_3_step
Agent: agentry_run_recipe("funnel_3_step",
        params: { step1: "page_view_landing", step2: "signup_started", step3: "signup_completed" })
      → returns { rows: [{step1_count: 4200, step2_count: 980, step3_count: 410}], render_hint: { type: "funnel", ... } }
Agent: renders a 3-row markdown table with drop-off % computed from the counts
```

11 canonical recipes cover the most-asked questions (DAU, cohorts, weekly retention, 3-step funnels, top events, conversion rate, top open errors, errors per hour, errors after last deploy, deploy frequency). For anything quirky, `agentry_query_docs` returns the schema + HogQL primer so the agent can compose ad-hoc queries via `agentry_analytics_query`.

## The console.log shape

```ts
// JS server / browser:
agentry.log(new Error("kaboom"));                              // → error case
agentry.log({ event: "checkout_completed", amount: 19.99 });   // → analytics
agentry.log({ sha: "deadbeef", branch: "main" });              // → deploy
agentry.log({ anything: "we route it for you" });              // → generic log
```

```python
# Python (requests):
agentry.log(exception)                                          # → error case
agentry.log({"event": "checkout_completed", "amount": 19.99})  # → analytics
agentry.log({"sha": "deadbeef", "branch": "main"})             # → deploy
```

Same shape for Ruby, Go, PHP, Java, .NET, Rust, Elixir, and shell. The unified endpoint is `POST /v1/log/:project_id/` — auto-detects what kind of signal each payload is and routes to the right pipeline.

## Server vs client install (the agent's mental model)

Most apps need **two install passes** — one for the server, one for the client. The MCP makes this explicit:

```
Backend (Express / Next.js server / Bun):
  agentry_install_guide(framework: "node" | "express" | "next")
    → installs @agentry/node, sets up uncaughtException/unhandledRejection,
      Express middleware, deploy events from CI

Frontend (React SPA / Next.js client / vanilla):
  agentry_install_guide(framework: "react" | "next-client" | "browser")
    → installs @agentry/browser, sets up window error listeners,
      ErrorBoundary, page_view tracking, key action tracking
```

The agent should detect both surfaces in the customer's repo (a typical Next.js app has both) and run through both guides. Then `agentry_verify_install` confirms signals from both ends reached agentry.

## What works (verified end-to-end)

- New user logs in via MCP → GitHub device flow → API key minted → persisted locally
- API key rotation (`agentry_rotate_key`)
- Project creation returns DSN + ready-to-paste install snippet
- **Comprehensive install guide** (`agentry_install_guide`) returns framework-aware steps with code snippets, file hints, and validation criteria for Node / Express / Next.js
- **Install verification** (`agentry_verify_install`) fires synthetic error + analytics + deploy events and reports which signals reached agentry — and persists `install_verified=true` on success so onboarding state moves to `ready`
- SDK captures Error / TypeError / SyntaxError / non-Error throws / strings / null
- SDK `track()` forwards analytics events through agentry to user's PostHog project (DSN auth, no exposed PostHog keys)
- SDK `deploy()` records deploy events that get surfaced in case detail's `recent_deploys`
- Ingest handles Sentry-shape, X-Sentry-Auth header, ?sentry_key= query
- Same fingerprint dedupes into one case (event_count increments)
- Tenancy: user A cannot read user B's cases / deploys / analytics (403)
- Case detail surfaces last 5 deploys for regression attribution
- Suppressions: substring pattern → auto_ignore returns 202 on subsequent matches
- Malformed JSON → 400 with `next_action` hint, never 500
- Huge stack (500 frames) → 200, no crash
- Unknown forward-compat fields → 200
- Body over 256 KB → 413 with structured error
- Analytics endpoints 503 with `analytics_not_configured` until PostHog env vars are set

## When you bring up the PostHog box

The agentry side is fully wired but inert until these four env vars exist:

```bash
cd apps/api
npx wrangler secret put POSTHOG_HOST                # e.g. https://posthog.agentry.sh
npx wrangler secret put POSTHOG_ORG_ID              # the org id from PostHog admin
npx wrangler secret put POSTHOG_MASTER_API_KEY      # personal API key with org-admin scope
npx wrangler secret put AGENTRY_TOKEN_ENC_KEY       # 32-byte base64url AES-256 key
```

Generate AGENTRY_TOKEN_ENC_KEY:

```bash
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url') + '\n')"
```

Without these set, `/v1/track/...` returns 503 `analytics_not_configured` and `agentry_login` returns `posthog: { provisioned: false }` — but everything else (errors, deploys, install guide, verify) works. So it's safe to ship error monitoring first and toggle analytics on later.

For local dev, set the same four vars in `apps/api/.dev.vars` (gitignored).

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

>>> agentry_status   (after create_project)
state: needs_install
next_action: "Call agentry_install_guide for the comprehensive checklist, walk through it, then call agentry_verify_install — that's how we know errors, analytics, and deploys are actually flowing."

>>> agentry_install_guide   (framework: detected automatically by reading package.json)
returns:
  steps: [
    install_sdk         → npm install @agentry/node
    set_env_vars        → AGENTRY_DSN, GIT_SHA
    init_at_entrypoint  → with framework-specific snippet
    track_signup        → server-side capture pattern
    track_key_actions   → 2-3 events for funnel
    fire_deploy_from_ci → GitHub Actions snippet
    verify_install      → call agentry_verify_install
  ]
  pitfalls: [...]
  signal_health_principles: [...]

... agent reads guide, edits customer code, commits, ...

>>> agentry_verify_install
returns: { ok: true, summary: "3/3 signal types verified",
           passed: ["errors","analytics","deploys"],
           checks: { errors: ✓, analytics: ✓, deploys: ✓ } }

>>> agentry_status   (after verify)
state: ready
next_action: "Onboarding done. Call agentry_list_cases or agentry_analytics_query."
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
