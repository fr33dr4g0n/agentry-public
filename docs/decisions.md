# Decisions log

Append-only. Newest at top.

---

## 2026-05-10 — User identification

Knowing which user hit which bug (and how many) is the difference between "we have an error" and "we have a customer impact estimate." Added throughout:

**SDK (Node + Browser):** `setUser({ id, email, username, traits })`, `identify(...)` alias, `clearUser()`. Sticky scope — set once, all subsequent `capture()` and `track()` calls auto-include the user. Browser SDK persists `user.id` to localStorage as the `distinct_id` so it survives reloads and lines up with PostHog. Explicit `ctx.user` on a single capture overrides the sticky scope.

**Schema:** added `user_id` and `user_email` columns to `events` with index `(project_id, user_id, received_at)` for fast per-user queries. Same identifier used as PostHog's `distinct_id` when both are wired — that lets the agent join error events with analytics events server-side.

**API ingest:** `ingest.ts` and `log.ts` now extract `user.id` / `user.email` from the standard Sentry-shape `user` object on every event and persist to the events row.

**Surfaced:**
- `agentry_get_case` returns `affected_users: { count, sample[] }` for the case's fingerprint
- new endpoint `GET /v1/cases/:case_id/users` — full list of distinct users for the case (top 100)
- new endpoint `GET /v1/projects/:project_id/users?days=30&limit=50` — top users by error count, including `distinct_fingerprints` (high distinct = wider regression for that user)
- 3 new cases-backend recipes: `top_users_by_errors`, `unique_users_24h`, `users_affected_by_case`

The reframe: errors without "who" are noise; analytics with "who" is intelligence. The two share a key now (`user_id` ≡ `distinct_id`), so the agent can answer "what did Alice do in the 2 minutes before her checkout failed?" — analytics events + error event by the same identifier, all visible to the agent.

## 2026-05-10 — Memory + health + quotas + alerts (the "make it actually live in production" pass)

Six new capabilities, ranked by leverage on agent workflows:

**Breadcrumbs in case detail.** The schema already accepted them; nothing exposed them. `agentry_get_case` now returns `recent_events[].breadcrumbs` (and `request`, `tags`, `extra`). Half a day of work, biggest single quality-of-debug improvement.

**Case search/filter.** Query params on the cases list endpoint: `q` (substring on error_type+message), `environment` (post-filter via events join), `deploy_sha` (exact), `since`/`until` (Unix seconds on lastSeenAt). Agent can answer "find all stripe-related cases in production this week" in one call.

**Local memory file `agentry_memory.md`.** The agent's persistent memory for case investigations lives in a markdown file at `<local_path>/agentry_memory.md` in the customer's repo — NOT a server table. Each case gets a `## Case <id>` section the agent upserts via `agentry_remember`. Why local: grep-able with the agent's existing file tools, git-versionable (customer chooses commit vs ignore), survives server-side data loss, human-editable. The reframe: tacit knowledge about the codebase belongs in the codebase, not in a vendor's database. New tools: `agentry_remember`, `agentry_recall`.

**Project health.** `GET /v1/projects/:id/health` returns `last_event_received_at`, `last_deploy_at`, `events_last_hour`, `open_cases`, `usage_this_month` (per-signal count + free-tier cap + pct), `webhooks` (per-hook last_status + last_error). Lets agents detect ingest gaps ("nothing received in 2h since the deploy — something broke") and approaching quota walls. New tool: `agentry_project_health`.

**Usage counters.** New `usage_counters (project_id, period YYYY-MM, signal_type, count)` table. Best-effort upsert on every successful ingest in `ingest.ts`, `log.ts`, `track.ts`, `deploys.ts`. Free-tier caps live in code: 5K errors / 50K analytics / 500 deploys per month. Surfaces through `agentry_project_health`. Required before freemium can ship.

**Alerts (customer-scheduled).** Store an alert definition: a recipe + parameters + threshold + linked webhook. agentry doesn't run a scheduler — the customer's cron / GitHub Actions / Cloudflare Cron POSTs `/alerts/:id/evaluate` when they want the check run. agentry runs the recipe, compares against threshold, fires the linked webhook on cross. Keeps agentry stateless and lets the customer own the schedule. v0 supports analytics-backend recipes only; cases-backend alerts deferred. Tools: `agentry_create_alert`, `agentry_list_alerts`, `agentry_evaluate_alert`, `agentry_delete_alert`.

The MCP now has 34 tools. Each one continues to surface an explicit `next_action` so the agent doesn't need separate orchestration logic.

## 2026-05-10 — Webhooks for "do X automatically when Y happens"

agentry now turns from a query surface into a programmable platform. Three events fire signed POSTs:

- `case.created`     — new error fingerprint
- `case.resolved`    — case status flipped to resolved
- `deploy.recorded`  — deploy event captured

**API:**
- `POST /v1/projects/:id/webhooks` body `{url, events?, description?}` → returns id + signing_secret (shown once)
- `GET /v1/projects/:id/webhooks` lists with last_status / last_error so the agent can tell if the customer's endpoint is healthy
- `DELETE /v1/projects/:id/webhooks/:id`
- `POST /v1/projects/:id/webhooks/:id/test` fires a synthetic ping
- `GET /v1/docs/automation` returns paste-ready Worker / Lambda / Functions templates

**Signing:** HMAC-SHA256(rawBody, signing_secret) → header `X-Agentry-Signature: t=<unix>,v1=<hex>`. Standard pattern.

**Implementation notes:**
- Signing secrets are encrypted at rest with `AGENTRY_TOKEN_ENC_KEY` (same key already used for PostHog read tokens). Stored alongside the SHA-256 hash so we keep public-prefix display + lookup AND can decrypt at firing time. v0 packs `<hash>::<iv>::<ciphertext>` into the same column rather than adding new schema columns; clean up to dedicated columns at the next schema change.
- Delivery uses `c.executionCtx.waitUntil(...)` so webhook firing happens AFTER the API response goes back. No retries in v0; the `last_status` / `last_error` columns expose health.
- Wired in three places: `ingest.ts` (Sentry-protocol case.created), `log.ts` (unified endpoint case.created + deploy.recorded), `cases.ts` PATCH handler (case.resolved on status transition), `deploys.ts` (deploy.recorded from typed endpoint).

**MCP:** `agentry_register_webhook`, `agentry_list_webhooks`, `agentry_test_webhook`, `agentry_delete_webhook`, `agentry_automation_docs`.

The reframe: agentry's webhooks are how customers build "auto-fix-on-error" without us shipping that feature ourselves. The user's endpoint gets a signed POST → spawns a Claude Agent SDK session → opens a PR → calls `agentry_resolve_case`. Each piece is small and the customer owns the policy.

## 2026-05-10 — Post-install conversational menu

After `agentry_verify_install` flips green, the user lands on a curated menu of next-step prompts:

- "Build a customized analytics dashboard"
- "Build an error monitoring dashboard"
- "Deploy health check"
- "Investigate my biggest current bug"
- "Review my signup funnel for drop-offs"
- "Compare metrics across deploys"
- "Generate this week's review post"
- "Set up automated fix-on-error" (preview — webhook-backed in a follow-up)

Each suggestion has a paste-ready `prompt_template` and lists the recipes/tools the agent will use (so the agent can also execute it directly without echoing the prompt back). The list is **state-aware** — `/v1/projects/:id/next-steps` checks for analytics_configured, has_cases, has_deploys, install_verified before deciding what to surface.

- New endpoint: `GET /v1/projects/:id/next-steps`
- New MCP tool: `agentry_suggested_next_steps`
- `agentry_verify_install` now embeds the top-5 suggestions in its success response so the agent can offer them inline without a second call

The reframe: agentry's onboarding doesn't end at "install works." It ends when the user has done one valuable thing with the data they're now collecting.

## 2026-05-10 — No dashboard: recipes + agent-readable query docs

agentry will not ship a dashboard. The user's Claude Code is the visualization layer. Two surfaces exposed for that:

- **Recipes** — `GET /v1/recipes` (catalog, no auth) + `POST /v1/projects/:id/recipes/:recipe_id/run` (api-key auth). 11 canned queries with parameters, expected columns, and `render_hint` telling the agent how to format the result. Backed by either HogQL (for analytics) or local SQL (for cases/deploys/errors).
- **Query docs** — `GET /v1/docs/query` returns markdown describing the events table, the cases/deploys schema, a HogQL primer, and visualization hints. The agent reads this when the user asks something the recipes don't cover, then composes ad-hoc HogQL via `agentry_analytics_query`.

MCP tools: `agentry_list_recipes`, `agentry_run_recipe`, `agentry_query_docs`.

The reframe: agentry is a signal store + query surface for agents. Visualization is a rendering concern that lives in the user's chat client. We don't compete with PostHog's UI for power users — we augment it with conversational access.

## 2026-05-10 — Unified /v1/log/ endpoint + multi-language HTTP recipes

agentry is now genuinely language-agnostic. The mental model is "just like console.log — fire JSON at the endpoint, we route it":

- **`POST /v1/log/:project_id/`** — accepts any JSON. Auto-detects by inspecting fields: `kind` if explicit, otherwise has-exception → error, has-sha (no event) → deploy, has-event → analytics, else → generic log line. Coerces `{name, message, stack}` shorthand into Sentry envelope before fingerprinting. Same DSN auth as the typed endpoints.
- **SDK `.log(payload)` method** added to both `@agentry/node` and `@agentry/browser`. Errors get serialized with stack; objects pass through; primitives wrap as `{kind: "log", value: ...}`.
- **Multi-language install guide variants** for `python`, `ruby`, `go`, `php`, `java`, `dotnet`, `rust`, `elixir`, `curl`. Each returns a ~30-line copy-paste helper using the language's stdlib HTTP client. **No agentry SDK install** — the helper IS the install. Customers can audit every line; we never ask them to vet a new dependency.
- **URL-form Sentry DSN** surfaced in project create response as `sentry_dsn_url`. Existing OSS Sentry SDKs in any language work by setting `SENTRY_DSN` to that URL — zero translation, zero glue code.
- **`ingest_url`** also surfaced for direct-HTTP callers — no math required, just paste it.

The pivot in framing: agentry isn't a set of SDKs that happen to talk to a server. It's a set of HTTP endpoints that happen to have SDKs for the JS ergonomics. Drop a 5-line helper in any language and you're done.

## 2026-05-10 — Browser SDK + CORS

Shipped `@agentry/browser` and CORS on the ingest endpoints. The product now captures from both server and client surfaces.

- **Browser SDK** is its own package (not a conditional export of `@agentry/node`) because the runtime APIs and bundling concerns are too different. Pure ESM, zero deps.
- **Auto-wires** `window.error` and `window.unhandledrejection` by default (`autoCaptureGlobalErrors: false` to opt out — useful when wrapping with a custom error boundary).
- **Stable analytics distinct_id** persisted to `localStorage`. Without this, every page reload would create a new "user" in PostHog.
- **`flushBeacon()`** uses `navigator.sendBeacon` so queued events survive page unload (fetch is cancelled on navigation; sendBeacon isn't). Auto-fires on `visibilitychange='hidden'`.
- **Multi-format stack parsing** — Chrome (V8) and Safari/Firefox emit different formats; both are parsed and normalized.
- **DSN in client bundles is fine** — it's an ingest-only public token. Documented in the install guide pitfalls so the agent doesn't waste time worrying about it.

CORS is permissive (`*`) on `/v1/store/*`, `/v1/track/*`, `/v1/deploys/*` and absent on auth/projects/cases/management endpoints. The DSN is meant for browsers; the API key never is.

`agentry_install_guide` now takes one of six framework targets: `node`, `next`, `express`, `browser`, `react`, `next-client`. Most apps need two install passes (one server, one client). `agentry_verify_install` is the same end-to-end canary.

## 2026-05-10 — Three signal types: errors, analytics, deploys + comprehensive install

Agentry now consumes three signal streams, all routing into the same case-investigation loop:

- **Errors** (existing) — Sentry-protocol ingest at `/v1/store/:project_id/`
- **Analytics** (new) — `/v1/track/:project_id/` proxies to a user-specific PostHog project. Multi-tenant: every agentry user gets one PostHog project auto-provisioned at GitHub login. PostHog handles all storage, dashboards, funnels, retention, replay.
- **Deploys** (new) — `/v1/deploys/:project_id/` records deploy events. Case detail surfaces the last 5 deploys via `recent_deploys` for regression attribution.

**Why deploys is huge:** "what regressed after deploy X" is the most-asked question during incident investigation. Adding the event type was nearly free (one new table, one new route) and unlocks 80% of the agent's RCA value.

**PostHog hosting:** the API supports the integration but is dormant until POSTHOG_HOST + POSTHOG_ORG_ID + POSTHOG_MASTER_API_KEY + AGENTRY_TOKEN_ENC_KEY are set. Multi-tenancy via PostHog's native projects + scoped Personal API Keys (one per agentry user, scoped to their project only). Read tokens are AES-GCM-encrypted at rest with a 32-byte master key.

**Comprehensive install guide:** `GET /v1/install/guide?framework=node|next|express` returns a framework-aware checklist of steps with file hints, code snippets, and per-step validation. The MCP exposes this as `agentry_install_guide`. After the agent walks through it, `agentry_verify_install` fires synthetic error + analytics + deploy events and reports which signals actually reached agentry. Errors that don't error and analytics that don't fire aren't useful — verification is the only proof the install works.

The onboarding state machine now has four states: `no_key → no_project → needs_install → ready`. `agentry_verify_install` flipping all green is the only way to advance to `ready`.

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
