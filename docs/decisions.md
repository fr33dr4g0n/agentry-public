# Decisions log

Append-only. Newest at top.

---

## 2026-05-09 — Implementation review fixes

Spawned a review agent on the codebase after passing tests + live e2e. Applied:

- Removed `ALLOW_UNVERIFIED_SIGNUP="true"` from `wrangler.toml [vars]` — would have shipped open signup on first deploy. Now must be set explicitly via `wrangler secret put` per env, with the obvious warning that it stays off until magic-link is added.
- Dropped regex support in suppression pattern matching (`apps/api/src/routes/cases.ts`). User-supplied regex runs on every ingest event for that project — classic ReDoS surface. v0 is substring-only. Re-add when we have a syntax-restricted alternative.
- Added body-size cap on ingest (default 256 KB, configurable via `MAX_BODY_BYTES`). Returns 413 before parsing JSON. Workers don't have built-in body size limits, so this is on us.
- Capped suppression count read per ingest (default 200, configurable via `MAX_SUPPRESSIONS_PER_PROJECT`). Bounds scan cost.

Deferred but documented in STATUS.md:
- Race on case upsert (use `ON CONFLICT DO UPDATE`)
- PII scrubbing on stored `request`/`extra`/`tags`/`user`
- `requireApiKey` `lastUsedAt` write on every request (use `waitUntil`)
- Rate limiting on `/v1/auth/signup`
- DSN recovery for projects created on a different machine

## 2026-05-09 — Bugs found during dogfood

- SDK was sending `{events: [...]}` batched but `/v1/store/:project_id/` (Sentry-protocol) takes one event per POST. Switched SDK to fan out POSTs in parallel.
- MCP `agentry_capture_test_event` was using `parseSentryDsnUrl` (URL-shape parser) on our bare-DSN format. Switched to `parseDsn`.

## 2026-05-09 — Hono routing trap

`router.use("*", requireApiKey())` on a sub-app mounted at `/v1` runs the middleware for EVERY `/v1/*` path passing through the sub-app, even paths the sub-app doesn't define. That blocked ingest with 401 because the cases sub-app was eagerly auth-gating. Fix: scope middleware to specific path patterns (`router.use("/projects/*", requireApiKey())`).

## 2026-05-09 — DSN format change

Original `agnt_<projectId>_<token>` collided with project ids containing underscores (uuid v7 has hyphens, but the underscore would be ambiguous if id were ever base64url which contains `_`). Switched separator to `.` since neither uuid v7 nor base64url contains `.`.

## 2026-05-09 — Initial architectural decisions

**Workspaces over monorepo tools.** npm workspaces (no pnpm available locally). Simpler, no extra install required.

**Email verification skipped in v0.** Sign up with email, immediately get API key. Risk: anyone can claim any email pre-launch. Acceptable with one user; mark v0 deploy as private-only.

**No GitHub App in v0.** Claude Code already has git tools. PR opening happens locally in the user's session. Add when we want headless / always-on triage.

**MCP server is the UX.** No web dashboard. A static `llms.txt` served from the API is the marketing surface.

**DSN scoping.** DSN is `agnt_<projectId>.<token>`. Ingest-only. Never grants reads.

**Sentry-protocol-compatible ingest.** Free SDK ecosystem later. `IngestEventSchema.passthrough()` for forward compat.
