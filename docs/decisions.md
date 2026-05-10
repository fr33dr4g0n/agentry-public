# Decisions log

Append-only. Newest at top.

---

## 2026-05-10 — Switched auth to GitHub OAuth device flow

Replaced the v0 email-signup placeholder with GitHub device flow. Notes:

- Drops three problems from STATUS.md in one move: open-signup vector, missing email verification, and signup rate-limiting (GitHub does it for us).
- New endpoints: `POST /v1/auth/device` (start) and `POST /v1/auth/device/poll`. Server is a thin proxy to GitHub plus our `users.github_id`-keyed upsert.
- Removed `/v1/auth/signup`, `/v1/auth/recover`. Kept `/v1/auth/keys/rotate` for when a user wants to invalidate the local key without redoing the GitHub dance.
- Added `/v1/auth/_test/login` gated behind `ENABLE_TEST_LOGIN=true` for local e2e + dogfood. Production secret store must never set this; production deployment of `wrangler.toml` puts the flag nowhere by default.
- Schema: added `github_id` (unique, not-null), `github_username`, `avatar_url` to `users`; demoted `email` to nullable + non-unique because a user may hide their primary GitHub email and we still want to provision them.
- MCP: collapsed `agentry_signup` / `agentry_recover` / `agentry_rotate_key` setup story into one `agentry_login` tool with three modes (`full`, `start_only`, `poll_once`). The default `full` mode blocks until GitHub authorizes, with a 180s default timeout. `start_only` + `poll_once` exists for agents that want to control the loop themselves.
- Scope is `read:user user:email` for now. When we add headless PR creation later we'll expand to `repo` and a single re-login covers it.

Reset Turso schema (destructive, only test data) via the existing `scripts/push.ts` which now drops everything before recreating.

## 2026-05-09 — Implementation review fixes

Spawned a review agent on the codebase after passing tests + live e2e. Applied:

- Removed `ALLOW_UNVERIFIED_SIGNUP="true"` from `wrangler.toml [vars]` — would have shipped open signup on first deploy. Now must be set explicitly via `wrangler secret put` per env, with the obvious warning that it stays off until magic-link is added. _(Superseded 2026-05-10: the env var is gone; GitHub OAuth replaces the whole concern.)_
- Dropped regex support in suppression pattern matching (`apps/api/src/routes/cases.ts`). User-supplied regex runs on every ingest event for that project — classic ReDoS surface. v0 is substring-only.
- Added body-size cap on ingest (default 256 KB, configurable via `MAX_BODY_BYTES`). Returns 413 before parsing JSON.
- Capped suppression count read per ingest (default 200, configurable via `MAX_SUPPRESSIONS_PER_PROJECT`).

Deferred but documented in STATUS.md:
- Race on case upsert (use `ON CONFLICT DO UPDATE`)
- PII scrubbing on stored `request`/`extra`/`tags`/`user`
- `requireApiKey` `lastUsedAt` write on every request (use `waitUntil`)
- DSN recovery for projects created on a different machine

## 2026-05-09 — Bugs found during dogfood

- SDK was sending `{events: [...]}` batched but `/v1/store/:project_id/` (Sentry-protocol) takes one event per POST. Switched SDK to fan out POSTs in parallel.
- MCP `agentry_capture_test_event` was using `parseSentryDsnUrl` (URL-shape parser) on our bare-DSN format. Switched to `parseDsn`.

## 2026-05-09 — Hono routing trap

`router.use("*", requireApiKey())` on a sub-app mounted at `/v1` runs the middleware for EVERY `/v1/*` path passing through the sub-app. Fix: scope middleware to specific path patterns (`router.use("/projects/*", requireApiKey())`).

## 2026-05-09 — DSN format change

Original `agnt_<projectId>_<token>` collided with project ids containing underscores. Switched separator to `.` since neither uuid v7 nor base64url contains `.`.

## 2026-05-09 — Initial architectural decisions

**Workspaces over monorepo tools.** npm workspaces — simpler, no extra install required.

**MCP server is the UX.** No web dashboard. A static `llms.txt` served from the API is the marketing surface.

**DSN scoping.** `agnt_<projectId>.<token>`. Ingest-only. Never grants reads.

**Sentry-protocol-compatible ingest.** `IngestEventSchema.passthrough()` for forward compat.
