# Agentry — Build Plan

**Status**: Active build
**Last updated**: 2026-05-09

## North star

Replace "developer reads error email and copy-pastes the stack into Claude Code" with "Claude Code receives the error already, with deploy SHA and repo context, and either opens a PR or marks the case spurious." The user's *own* Claude Code subscription does the work — agentry never runs LLM calls server-side.

## Hard constraints

1. **AGENTS FIRST.** Every interface decision must serve agents over humans. The MCP server is canonical. No web form is ever required for onboarding, signup, key generation, or project setup. Humans interact via their agent.
2. **Zero LLM cost on agentry's books.** All AI work runs in the user's Claude Code session.
3. **Sentry-wire-protocol-compatible ingest** so existing language SDKs Just Work later.
4. **Onboarding ≤ 2 prompts of human input**. The agent does the rest.

## Architecture

```
┌──────────────────┐  agentry SDK    ┌────────────────────┐
│ User's app       │────────────────▶│ Cloudflare Worker  │
│ (musicvideogen)  │  events         │ (Hono + Drizzle)   │
└──────────────────┘                 └────────┬───────────┘
                                              │
                                     ┌────────▼───────────┐
                                     │ Turso/libSQL       │
                                     └────────┬───────────┘
                                              │
                                     ┌────────▼───────────┐
                                     │ User's Claude Code │
                                     │ + @agentry/mcp     │
                                     └────────────────────┘
```

The MCP server is **client-side** — it runs in the user's Claude Code via stdio, talks to the API over HTTPS using the user's API key.

## Repo layout

```
agentry/
├── apps/
│   └── api/                  Cloudflare Worker — single deploy unit
├── packages/
│   ├── shared/               Zod schemas, types, fingerprinting, errors
│   ├── db/                   Drizzle schema + migrations
│   ├── sdk-node/             @agentry/node — Node SDK
│   └── mcp/                  @agentry/mcp — stdio MCP server (the UX)
├── tests/
│   ├── e2e/                  Hits deployed Worker end-to-end
│   ├── chaos/                Random/adversarial error shapes
│   └── onboarding/           Sub-agent simulates a user signing up
├── PLAN.md                   This file
├── STATUS.md                 Continuously updated, user reads on return
├── CLAUDE.md                 Instructions for future Claude sessions in this repo
├── README.md                 Human + agent friendly intro
├── llms.txt                  Agent-friendly capabilities surface
└── package.json              npm workspaces root
```

## Database schema (Turso/libSQL via Drizzle)

All ids are `text` (uuid v7 for time-orderability). Timestamps are `integer` unix-seconds.

- `users` — id, email (unique), created_at
- `auth_codes` — id, email, code_hash, expires_at, used_at, created_at
- `api_keys` — id, user_id, prefix, key_hash, name, last_used_at, created_at, revoked_at
- `projects` — id, user_id, name, repo_url (nullable), default_branch, dsn_prefix, dsn_hash, created_at
- `events` — id, project_id, fingerprint, error_type, message, stack, deploy_sha, breadcrumbs_json, request_json, environment, received_at
  - Index on (project_id, fingerprint, received_at desc)
- `cases` — id, project_id, fingerprint (unique with project_id), error_type, message, status (`open`/`investigating`/`resolved`/`spurious`/`ignored`), event_count, first_seen_at, last_seen_at, last_deploy_sha, agent_summary, pr_url
- `agent_runs` — id, case_id, started_at, finished_at, status, summary_md, pr_url, action (`pr_opened`/`escalated`/`marked_spurious`/`failed`)
- `suppression_entries` — id, project_id, fingerprint_pattern (regex or substring), action (`auto_ignore`/`auto_resolve`/`prompt_hint`), reason, hint_text, created_at

## API surface

All responses include `next_action` hint when relevant — the response is consumed by an agent, so tell it what to do next.

### Auth & onboarding
- `POST /v1/auth/signup` — `{email}` → `{api_key, user_id, prefix, next_action: "Store this api_key in ~/.agentry/config.json — it won't be shown again. Then call POST /v1/projects to create a project."}`
  - v0 has **no email verification.** Same email twice returns a new key for the same user. Existing keys remain valid until explicitly revoked.
  - This is the recovery path: re-call `signup` with the same email to mint a new key.
  - Hard-locked behind `ALLOW_UNVERIFIED_SIGNUP=true` env var. Unset in any production-facing deploy.
- `POST /v1/auth/keys/rotate` — `{old_key_in_auth_header}` → new key, revokes old.

### Projects
- `POST /v1/projects` — `{name, repo_url?, default_branch?}` → `{id, dsn, next_action}`
- `GET /v1/projects` — list user's projects
- `GET /v1/projects/:id` — detail

### Ingest
- `POST /v1/store/:project_id/` — Sentry-protocol-compatible (auth via DSN)
- `POST /v1/events` — agentry-native simpler shape (auth via DSN or API key)

### Cases (consumed by MCP server / agent)
- `GET /v1/projects/:id/cases?status=open` — list
- `GET /v1/cases/:id` — detail with recent events and memory hints
- `PATCH /v1/cases/:id` — `{status, agent_summary?, pr_url?}`
- `POST /v1/cases/:id/runs` — record an agent run
- `POST /v1/projects/:id/memory` — record a learned pattern

### Agent discovery
- `GET /llms.txt` — short agent-friendly capability summary, hand-written
- `GET /v1/install/sdk/node` — returns the install snippet as JSON for agents to render

## MCP server tools (the UX)

Tools chosen so an agent can do every operation without touching a web page.

- `agentry_status()` — what's set up, what's missing, what to do next
- `agentry_signup(email)` — returns API key, persists to local config
- `agentry_recover(email)` — re-runs signup, gets a fresh key (since v0 has no email verification)
- `agentry_list_projects()`
- `agentry_create_project(name, repo_url?, local_path?)` — returns DSN + install snippet. `local_path` defaults to MCP client's CWD when available; lets agent map cases back to the right repo on disk.
- `agentry_install_sdk(project_id, language="node")` — returns the exact code to paste
- `agentry_list_cases(project_id?, status?)` — defaults to `open` for the most recent project. Response includes `local_path` per case so the agent knows where to `cd`.
- `agentry_get_case(case_id)` — full detail with stack, deploy SHA, memory hints, and `local_path`
- `agentry_resolve_case(case_id, summary?, pr_url?)`
- `agentry_mark_spurious(case_id, reason?)` — feeds noise-suppression layer
- `agentry_record_suppression(project_id, fingerprint_pattern, action, reason, hint?)` — record a noise rule
- `agentry_capture_test_event(project_id)` — fires a fake error so the user can verify ingest works

The MCP server stores config in `~/.agentry/config.json`:
```json
{
  "server_url": "https://agentry.workers.dev",
  "api_key": "agk_...",
  "default_project_id": "...",
  "projects": {
    "<project_id>": { "name": "...", "dsn": "...", "local_path": "/abs/path/to/repo" }
  }
}
```

## SDK (Node, v0 only)

`@agentry/node`:
```ts
import { agentry } from "@agentry/node";
agentry.init({
  dsn: process.env.AGENTRY_DSN!,
  deploySha: process.env.GIT_SHA,
  environment: process.env.NODE_ENV
});
process.on("uncaughtException", err => agentry.capture(err));
process.on("unhandledRejection", err => agentry.capture(err));

// or manually:
try { ... } catch (e) { agentry.capture(e, { extra: {...} }); }
```

Internals: queue + flush on interval, sane defaults (5s, 100 events), graceful shutdown flush, structured-clone safe payload, fingerprint computed client-side as `SHA1(error_type + ":" + first stack frame fn + ":" + first stack frame file)`.

## Fingerprinting

`fingerprint = sha1(error_type + ":" + frame0.function + ":" + normalize(frame0.filename) + ":" + frame0.lineno)`

Normalize filename: strip query strings, collapse `node_modules/.../foo` to `node_modules/foo`. Server recomputes on ingest if client didn't supply.

## Noise suppression layer (a useful feature, not defensibility — plan-review correction)

After each case closes, optionally write a `suppression_entry`. On next event ingest, before creating a `case`, check rules for matches:
- `auto_ignore` → drop event silently (still increment a counter for observability)
- `auto_resolve` → mark new case as resolved with the recorded summary, no agent dispatch
- `prompt_hint` → attach `hint_text` to case so when the agent reads it via `agentry_get_case`, it gets the context

Matching: substring match on fingerprint by default; regex if pattern starts with `/`.

Reframed: this is **noise suppression** so users (and their agents) don't get pinged repeatedly about the same triaged thing. It is not a moat. The defensibility, if any, comes from product fit + agent-first distribution.

## Tests

Vitest everywhere. Categories:

1. **Unit** (`packages/*/src/**/*.test.ts`): pure logic — fingerprinting, validation, dsn parsing, hashing.
2. **API integration** (`apps/api/test/`): wrangler local + miniflare + in-memory libsql. Cover all routes, all auth paths, all error responses.
3. **Chaos** (`tests/chaos/`): generate adversarial error shapes — empty stack, 100kb stack, unicode in messages, circular refs in extra, missing fields, oversized payloads, non-Error throws (`throw "string"`, `throw {custom}`), async stack traces, minified JS stacks. Assert API never 5xxs.
4. **E2E** (`tests/e2e/`): hit deployed worker. Sign up → create project → ingest event via SDK → list cases via MCP → resolve case. Agent simulates each step.
5. **Onboarding sim** (`tests/onboarding/`): spawn a sub-agent that pretends to be a new user invoking the MCP from cold. It must succeed without any web interaction.

## Build sequence (autonomous, post plan-review)

1. **[seq, me]** Scaffold npm workspace + tsconfig
2. **[seq, me]** Build `packages/shared` (frozen contract: zod schemas, fingerprint, DSN parse, types, error helpers, `requireProjectAccess` helper). FREEZE before parallelizing.
3. **[seq, me]** Build `packages/db` (drizzle schema, migrations setup)
4. **[par x3]** Spawn build agents in parallel: `apps/api`, `packages/mcp`, `packages/sdk-node`. Each consumes frozen `shared`.
5. **[seq, me]** Wire it all together, install, typecheck, run unit + integration tests
6. **[seq, me]** `drizzle-kit push` to Turso, deploy Worker, run e2e against deployed
7. **[par, me]** Implementation review agent on the full repo
8. **[seq, me]** Wire SDK into musicvideogenerator. Throw a real error. Verify via MCP.
9. **[seq, me]** Final STATUS.md with one-command install instructions for the human.

## v0 explicitly out of scope (post plan-review trim)

- GitHub App / repo_dispatch (deferred — Claude Code does PR creation locally)
- Billing / Stripe / quotas (free tier hard-coded)
- **Email verification entirely** — `signup` returns API key directly. Public deploy off-limits until v0.1 adds magic-link.
- Web dashboard
- SDKs other than Node
- Multi-user permissions (one user owns N projects)
- Source map upload / symbolication
- Sampling, rate limiting beyond hard cap
- OAuth (no GitHub login, no SSO)
- **Auto-generated OpenAPI spec** — write llms.txt by hand instead
- **Second "native" ingest endpoint** — Sentry-protocol only
- **Standalone chaos test suite** — fold a few adversarial cases into integration tests
- **Onboarding sim sub-agent** — replaced with manual end-to-end test from a clean state

## Risks I'm watching

1. **MCP install friction.** Use local-path install during dev: `claude mcp add agentry -- node /abs/path/to/packages/mcp/dist/index.js`. Publish after first review.
2. **DSN auth ergonomics.** DSN scoped to ingest-only. Never grants reads.
3. **Email-less signup security.** v0 has no email verification. Anyone can claim any email. Hard-gated behind env var. Do not deploy publicly until v0.1.
4. **Cloudflare Workers + libSQL gotchas.**
   - Use `@libsql/client/web` (not the default Node entrypoint) on Workers
   - No `crypto.createHash` — use Web Crypto `crypto.subtle.digest`
   - No `Buffer` — use `Uint8Array` + `TextEncoder`
   - Drizzle migrations cannot run from inside the Worker — `drizzle-kit push` from build host
   - Turso connection requires `url` + `authToken` set on every Worker request; cache the client per-request, not globally (Workers reuse isolates unpredictably)
5. **Worker cold start + Turso latency.** Acceptable for ingest, may be slow for MCP. Tolerate in v0.
6. **Shared contract drift across parallel agents.** Mitigated by freezing `packages/shared` before fan-out.
7. **Tenancy.** Single helper `requireProjectAccess(env, apiKey, projectId)` and `requireCaseAccess(env, apiKey, caseId)` in `shared`. Every protected route MUST use it. Lint or test for this.

## Definition of done (v0)

- I can run `claude mcp add agentry <local-path>` in a fresh repo
- Conversation: "set me up with agentry" → agent walks user through email → code → API key → project → DSN → SDK install snippet, all without leaving the chat
- Drop SDK into musicvideogenerator, throw a test error, ask "any new cases?" — agent finds it
- Full test suite green
- STATUS.md has the exact commands the user needs to try it themselves
