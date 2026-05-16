# Decisions log

Append-only. Newest at top.

---

## 2026-05-16 (~02:30 UTC) — Audit log, rate limit, 5 agent-shortcut tools, EU data residency disclosure

**Context.** After shipping the three-token doc + 15 PostHog CRUD tools earlier in the day, I gave the user a punch list of gaps and improvements. The user asked to ship all of them and specifically asked the audit-log read tool to accept a configurable `hours` parameter (default 24, allow 48 / 72 / etc.).

**Decisions:**

1. **Audit log = append-only `audit_log` table** with (user_id, project_id?, action, resource_type, resource_id, summary, metadata_json, ip, ua, at). All 9 mutating handlers across feature flags / cohorts / surveys / publications / session-replay-config / A/B-tests write one row before returning success. Writes never block — wrapped in try/catch, errors logged but observability never breaks user-visible operations. Read endpoint `GET /v1/audit/recent?hours=24` accepts `hours` 1..720, plus `action_prefix` + `resource_type` + `project_id` + `limit` (max 500). MCP tool `agentry_recent_changes` mirrors.

2. **Rate limit on `/v1/public/q/*`** = in-isolate token bucket keyed on (publication_id, client_ip), 60 capacity / 1 token-per-second refill. Per-isolate (not per-edge — Workers globals persist for the isolate lifetime which is minutes-to-hours, plenty to break a single-source attacker's loop). KV/DO would add cost-per-request without proportional benefit for this threat model. 429 with `Retry-After` header on exceed. GC drops idle buckets every minute (10 min idle TTL).

3. **5 high-value agent shortcuts:**
   - `agentry_evaluate_feature_flag(distinct_id, key?)` calls PostHog's `/decide/?v=3` with the team's public write key (not master) — same endpoint clients hit at runtime. Returns one flag value if `key` given, otherwise the map of all active flags for that user.
   - `agentry_get_distinct_id_summary(distinct_id)` is a fan-out: PostHog persons lookup + 2 HogQL queries (stats + recent events) + recordings list. Composed in the API to keep the tool's response shape stable and save 3+ MCP round trips. Each branch is wrapped in try/catch — if one fails (e.g. recordings off), the rest still returns.
   - `agentry_survey_responses(survey_id)` runs a fixed HogQL pair (distribution + recent free-text) plus pulls the survey definition for choice labels. Caller doesn't need to know `$survey_response` property unpacking.
   - `agentry_create_ab_test({name, success_event, variants})` mints a multivariate PostHog feature flag (auto-split rollout if not specified, must sum to 100) AND returns the bound conversion HogQL string. The agent feeds the query into `agentry_analytics_query` on a schedule.
   - `agentry_get_replay_snapshots(replay_id, source?)` thin wrap of PostHog's `/session_recordings/<id>/snapshots/`. Returns rrweb-format DOM events for programmatic "what did the user click before the error" reconstruction.

4. **EU data residency disclosure** — `/v1/privacy/disclosure` now returns a `data_residency` block: PostHog self-hosted on Hetzner Falkenstein, Cloudflare Workers + Turso for error events, R2 for sourcemaps, TLS 1.3 end-to-end. Paste-ready markdown clause includes the section.

5. **SDK package cleanup** — `packages/sdk-node` and `packages/sdk-browser` deleted. agentry has no SDK by design; the install flow generates a 25-line fetch helper. The unpublished packages confused contributors looking at the repo.

**Why audit-log row writes are best-effort, not transactional.** The mutation already succeeded against PostHog at the time the audit write happens. If we waited on the audit write before responding to the user, every audit-log DB hiccup would surface as a user-visible "PostHog call worked but agentry failed" error. Worse: the user might retry, doubling up the underlying mutation. Audit data is observability; it's allowed to be slightly lossy. The audit write is wrapped in try/catch and logs on failure for ops monitoring.

**Why in-isolate rate limit, not Cloudflare's WAF / native rate limiter.** Two reasons: (1) source-controlled — visible in the repo, testable, no UI config to forget about. (2) per-isolate persistence covers the realistic threat (a script looping from one source). Distributed coordination across colos isn't worth the complexity — an attacker spreading across colos is *good* for us, they're literally spreading their cost across our infra. The bucket-per-(publication, IP) shape stops the "one client refreshes every 100ms" footgun cleanly.

**MCP package now at 0.0.13.** 47 + 21 = 68 tools total. Worker version `26b9df1c-a82a-4765-939e-2eb5ad6e3cb0`. 127 api / 11 mcp / 28 shared tests pass.

---

## 2026-05-15 (night, late) — PostHog CRUD MCP tools (feature flags / cohorts / surveys / replays) + three-token doc clarification

**Problem.** Two related gaps. (1) Earlier rounds shipped session-replay
*configuration* MCP tools but no retrieval, and shipped no MCP for feature
flags / cohorts / surveys at all — they were documented as "MCP coming
once we expand master-key scope". The scope was expanded today and the
tools were never built. (2) Docs presented agentry as a two-key system
(`agk_` private + `agp_` public dashboard), but in practice SPAs ship a
third token — the project DSN (`agnt_<projectId>.<token>`) — for ingest.
A user reading the lean reference could miss that the DSN is the safe
key for client bundles and worry whether the private key leaks.

**Decisions.**

1. **Ship the 15 deferred MCP tools.** New routes file
   `apps/api/src/routes/posthog-features.ts` exposes per-team CRUD:
   `feature-flags` (list/get/create/update/delete),
   `cohorts` (list/get/create/delete),
   `surveys` (list/get/create/delete),
   `session-replays` (list/get).
   Each route requires `agk_` Bearer + project_id; the team_id is derived
   server-side from the user. PostHog's master Personal API Key (`phx_…`,
   rotated to `*` scope on 2026-05-15) does the actual call. Per-user team
   isolation is enforced by PostHog itself — the master key authenticates,
   the team_id in the URL scopes.

   Tool shapes match an agent's mental model:
   - Feature flags: simple `{key, rollout_percentage}` AND advanced raw
     `filters` (PostHog's property-targeted / multivariate / cohort-scoped
     filter object).
   - Cohorts: simple `{name, event, days?}` AND advanced raw `groups`.
   - Surveys: quick `{name, question, question_type?}` AND multi-question
     `questions: [...]`. Created in draft — agent passes `start_date` (ISO)
     to launch.
   - Session replays: filter by `distinct_id` (e.g. from a case's
     affected_users) + date range. Returns `player_url` for one-click view.

   Generic `posthogTeamApi<T>(env, userId, pathSuffix, opts)` helper in
   `posthog.ts` keeps the routes terse and ensures all of them go through
   the same auth + timeout + error surface.

2. **Three-token clarification table in `/agentry.md`.** Replaced the
   "Two API keys" section with a Three-token table laying out `agk_` /
   `agp_` / `agnt_<projectId>.<token>` side-by-side: format, what each
   auths, whether safe in SPA bundle, where to mint/rotate, blast radius
   if leaked. Makes unmissable that the DSN (not `agk_`) is what SPAs
   bundle for ingest.

**Why both at once.** The token clarification is a small text change; the
PostHog CRUD is a larger feature; but the agent reads `/agentry.md` cold
and decides what to do next, so the MCP tool table needs the 15 new
tools at the same time the table format changes. Doing both in one round
keeps the lean reference and the MCP package in lockstep — a property the
user explicitly asked for ("these need to mirror each other").

**Test posture.** `apps/api/test/api.test.ts` now asserts the lean
reference contains "Three tokens", "agnt_<projectId>", "Blast radius",
`agentry_create_feature_flag`, `agentry_list_session_replays`; and that
`/agentry-install.md` contains the per-resource feature-flag / cohort /
survey tables. MCP snapshot test updated with all 15 new tool names.

**Live verification.** New master key (`phx_…wNWD9LDGn63d…`) curl-checked
against PostHog `/api/projects/@current/{feature_flags,cohorts,surveys,
session_recordings}/` returns 200 on each. Deployed Worker version
`e009fd4c-f5d0-4f48-8a32-60f314356b37`.

---

## 2026-05-15 (night) — Split agentry.md into lean reference + install handbook

**Problem.** `/agentry.md` had grown to ~400 lines: install flow, session replay strategies, sourcemap deep dive, feature-flag status, webhook templates, recipe catalog, privacy disclosure — all in one file. Every agent fetching it for day-to-day API reference was dragging along 200+ lines of install boilerplate it didn't need. Context-bloat after onboarding is a real cost in long-running agent sessions.

**Decision.** Split into two endpoints:

  - **`GET /agentry.md` — lean reference.** Canonical principle (data plane vs compute plane), two-prompt onboarding, signal types, cases, **two-key model (agk_ + agp_)**, the complete API surface, the full MCP tool table, error envelope, source pointers. ~280 lines.
  - **`GET /agentry-install.md` — install + ops handbook.** 12-step install flow, sourcemap upload + unmangle, session-replay strategies, feature-flag/cohort/survey status, webhook templates, recipe catalog, public-dashboard publish flow, privacy-disclosure paste-ready clause. Fetched on demand during install or when wiring a new ops feature.

`/llms.txt` still aliases `/agentry.md` (back-compat). The lean reference opens with an admonition pointing first-time installers at `/agentry-install.md`. The `/` discovery JSON now returns both URLs (`docs` + `install_docs`).

**Why this design.** An agent's context budget should hold the bits relevant to its current task. The 12-step install is one-shot — once a project is wired, those tokens are dead weight. The lean reference also fits more comfortably alongside other system prompts. Splitting also lets us evolve the install flow (e.g. new steps, new framework detection) without churning the reference doc that every agent invocation reads.

**Why HTTP-served instead of a static `agentry-install.md` on the web origin.** Single source of truth: the install steps are tied to the API surface (which lives on the Worker). Serving both from `api.agentry.sh` means a single deploy updates both. The Pages `_redirects` 302s `agentry.sh/agentry-install.md` → `api.agentry.sh/agentry-install.md` so both hostnames work.

**Tests.** `apps/api/test/api.test.ts` now asserts: (a) `/agentry.md` does NOT contain the 12-step heading, (b) `/agentry.md` DOES contain `agp_` + `agentry_publish_query` (lean reference must include the public-key surface since it's API + MCP, not install), (c) `/agentry-install.md` contains the 12-step install + sourcemaps + session-replay + webhooks + recipes + privacy sections, (d) `/llms.txt` still serves the lean reference.

---

## 2026-05-15 (evening, late) — Public dashboard key (`agp_…`) — Stripe-style publishable token

**Problem.** Agents can already publish a recipe + params as a "dashboard view" (e.g. running totals for a status page). The blocker was auth: handing out the user's `agk_` private key to a public-facing page would give visitors full account access. Status pages and embedded charts need a token that's safe to ship in the bundle.

**Decision.** Every account auto-mints TWO keys at first login:

  - **Private (`agk_…`)** — day-to-day. Authenticates every authenticated endpoint via `Authorization: Bearer agk_…`. Same as before.
  - **Public dashboard (`agp_…`)** — Stripe-style "publishable" key. Safe to embed in public-facing client code. ONLY authenticates `GET /v1/public/q/<publication_id>?key=agp_…` (the visitor-facing query-execution endpoint), and ONLY for publications the user has explicitly minted. No cases, no deploys, no raw events, no ad-hoc HogQL.

The publish flow:

  1. Agent runs `agentry_publish_query(project_id, recipe_id, params)`.
  2. API mints a `publication_id`, binds the recipe + params, returns `embeddable_url`: `https://api.agentry.sh/v1/public/q/<publication_id>?key=agp_…`.
  3. Anyone GET-ing that URL gets the recipe's rows. Open CORS — fetchable from any browser page.
  4. Revoke via `agentry_revoke_publication`.

**Schema.** Additive migration applied to prod Turso: `api_keys.kind` enum (`private`|`public`, defaults `private`), new index `(user_id, kind)`, new table `public_query_publications` (id, user_id, project_id, recipe_id, params_json, description, created_at, last_used_at, revoked_at). MCP persists `public_api_key` into local config alongside `api_key`; `persistKeyResponse` writes both.

**Why Stripe's model.** Stripe's `pk_…` / `sk_…` split is the proven pattern for this exact problem. Two keys, sharp blast-radius for the public one, no clever capability-token gymnastics. Anyone reading the docs immediately understands.

**Why ban arbitrary HogQL on the public surface.** A `agp_` key + ad-hoc HogQL is functionally equivalent to giving visitors read access to all events. Binding to a (recipe, params) tuple at publish time means the agent can't accidentally publish "all the things" — the recipe schema is reviewable, the params are explicit.

**MCP tools.** `agentry_publish_query`, `agentry_list_publications`, `agentry_revoke_publication`. All in the lean `/agentry.md` reference's MCP tool table.

---

## 2026-05-15 (evening) — Session replay opt-in + agent-driven strategy

**Problem.** PostHog session replay is technically available on every per-user team (we self-host the full OSS stack), but eats significant storage. "Recording every session always" is the wrong default — it bankrupts disk for any non-trivial traffic.

**Decision.** Session replay is OFF by default at the team level. agentry's MCP exposes `agentry_configure_session_replay` so the agent can enable it on the user's explicit request, choosing one of five strategies tuned to the storage/coverage tradeoff:

  - `off` — disable.
  - `all` — 100% sampling. Storage-heavy; pick only at low traffic.
  - `sampled` — random sample at `sample_rate` (default 0.1 = 10%). Default-sensible.
  - `url_scoped` — record only sessions hitting specific URLs (e.g. `/checkout/*`). Best for funnel debugging.
  - `errors_only` — recording never auto-starts; the customer's app calls `posthog.startSessionRecording()` from captureError (or similar trigger). Cheapest — replay tape rolls only when something breaks. Agent wires the call into the customer's agentry helper.

The agent's conversational UX (from `agentry.md`): ASK the user which strategy, ask retention (30/90/365 days), then call `agentry_configure_session_replay`. For `errors_only`, the agent ALSO edits the customer's helper to call `posthog.startSessionRecording()` inside the error path.

Retention is enforced by PostHog itself via `session_recording_retention_period` on each team — no agentry cron needed. Recordings older than the period are deleted automatically.

**Implementation.** `PATCH /api/environments/<team_id>/` on PostHog accepts the per-team settings update. The master Personal API Key has scope to modify team settings, so no admin-sidecar dependency for runtime toggles. New routes:

  - `POST /v1/projects/:id/posthog/session-replay/configure` — accepts {strategy, sample_rate?, retention_days?, min_duration_ms?, url_triggers?}, maps to PostHog team settings.
  - `GET /v1/projects/:id/posthog/session-replay/status` — returns current config + a deep-link `web_ui_url` into PostHog's Replay tab.

**Programmatic recording retrieval — gated on master-key scope expansion.** PostHog's `GET /api/environments/<team_id>/session_recordings/` endpoint requires the Personal API Key to have `session_recording:read` scope. The default master key (minted in PostHog's UI without explicit scope selection) doesn't have it. Same gate blocks `feature_flag:*`, `cohort:*`, `survey:*`.

Workaround until the scope is widened: agent calls `agentry_session_replay_status`, surfaces the `web_ui_url` to the user, user views recordings in PostHog's browser UI. Direct retrieval via MCP is a follow-up.

**Feature flags / cohorts / surveys / A/B tests — same story.** All supported by the OSS stack on every per-user team. Accessible today via HogQL (cohorts) + PostHog's web UI (everything). MCP tools are pending one operator action: rotate the master Personal API Key in PostHog's UI to grant `*` scope (or the explicit feature/cohort/survey/recording scopes). Once expanded, ~5 MCP tools per feature land in a follow-up release. `agentry.md` documents both the existing access paths and the pending MCP surface so an agent reading it cold doesn't repeatedly try the unscoped endpoints.

**Why this design (vs always-on recording).** Storage cost is real. PostHog OSS stores recordings in object storage (SeaweedFS in our deploy); they're large. Letting the agent + user choose a strategy keeps storage proportional to debugging value. The `errors_only` strategy is particularly powerful — recording only "the 30s of session that preceded the error" gives you the highest signal-per-byte ratio possible.

---

## 2026-05-15 (later) — PostHog isolation v3: per-user teams via admin sidecar

**Problem.** After the shared-project + group wrap refactor (entry below), I asked myself the right question: is the wrap iron-clad? Honest answer: no. The wrap is a regex; an attacker with deep HogQL knowledge could probably find a syntax that confuses it (backtick-quoted identifiers, schema-prefixed table names, PostHog-specific virtual columns like `events.person` that pull from un-isolated `persons` data, ClickHouse `SETTINGS` clauses, Unicode look-alikes, etc.). Each new HogQL feature is a new potential bypass surface. With "a leak would kill the project" as the stated stakes, the regex approach is too brittle.

**Trigger.** User asked: "is this iron-clad?" → I had to admit no.

**Insight while testing the wrap.** PostHog's HogQL compiler hardcodes `WHERE events.team_id = <forced>` into every generated ClickHouse query, at the AST level. Verified by inspecting the `clickhouse` field on query responses: every events reference (and related tables like `error_tracking_*`, `person_distinct_id_overrides`) gets `team_id = X` injected by PostHog before the user's HogQL ever reaches the database. This is the same isolation Enterprise customers get — it's part of PostHog's open-source codebase, not a paid feature.

The Enterprise license only gates one thing relevant to us: **project creation via the API**. Specifically `POST /api/organizations/:id/projects/` returns `403 permission_denied: max projects reached` on the OSS unlicensed tier when org.available_product_features doesn't include `organizations_projects`.

The team_id mechanism itself is identical between OSS and Enterprise. If we get more team_ids, we get ironclad isolation for free.

**Path taken: admin sidecar that creates teams via direct Postgres INSERT.**

A small Python HTTP service (`agentry-admin`) runs alongside PostHog on the Hetzner VPS. It listens on `posthog.agentry.sh/agentry-admin/` (Caddy reverse-proxy), authenticates via a shared bearer token, and on `POST /provision-team` does:

```sql
BEGIN;
INSERT INTO posthog_project (id, name, ...) VALUES (...);
INSERT INTO posthog_team (uuid, project_id, api_token, ...) VALUES (...) RETURNING id, project_id;
COMMIT;
```

Returns `{team_id, project_id, api_token}`. PostHog's HogQL compiler doesn't care HOW the team was created — it just sees a row in `posthog_team` and enforces `team_id` on queries against it. Every query against `/api/projects/<team_id>/query/` gets PostHog's native isolation, AST-level, identical to Enterprise.

**Verified live.** Created test team_id=6 via direct INSERT. Sent 4 events. PostHog generated this ClickHouse SQL for a UNION/subquery/comment "bypass" attempt:

```sql
WHERE and(equals(events.team_id, 6), equals(events.event, %(val)s))
... UNION ALL ...
WHERE and(equals(events.team_id, 6), equals(events.event, %(val)s))
```

Both SELECTs in the UNION got `team_id = 6`. Plus PostHog injected the same filter into related tables (`error_tracking_*`, `person_distinct_id_overrides`). The depth of isolation here is what PostHog Cloud serves thousands of paying customers with.

**Architecture, current state:**

```
                                  ┌──────────────────────────────┐
agentry-api Worker (Cloudflare)   │  Hetzner VPS (Caddy + docker)│
                                  │                              │
  ensurePosthogForUser(userId) ──▶│ /agentry-admin/provision-team│
                                  │      │                       │
                                  │      ▼                       │
                                  │  agentry-admin (Python)      │
                                  │      │                       │
                                  │      ▼  INSERT INTO ...      │
                                  │  posthog Postgres            │
                                  │      ▲                       │
  forwardCapture(userId, evt) ────▶ /capture/ (Rust)             │
       writes via user's          │   (validates api_token →     │
       team api_token             │    team_id stamped at ingest)│
                                  │                              │
  runHogQl(userId, hogql) ────────▶ /api/projects/<team_id>/query│
       team_id is in the URL      │   PostHog Django HogQL       │
       → PostHog enforces filter  │   compiler hardcodes         │
       at AST level                │   `team_id = <team_id>`     │
                                  └──────────────────────────────┘
```

**posthog_projects table per agentry user:**
- `posthog_project_id` = PostHog team_id (the URL parameter for query endpoint)
- `posthog_project_api_key` = team's write key (phc_…) for /capture/
- `posthog_host` = POSTHOG_HOST
- `read_token_enc/read_token_iv` = LEGACY (kept to satisfy NOT NULL constraint; encrypted dummy value)

**What got deleted:**

- `wrapEventsTable()` — regex-level events-table rewriting. No longer needed.
- `validateHogQl()` blocklist — no longer needed.
- The `trusted` flag on `runHogQl` — no special path for recipes.
- The shared-project model (POSTHOG_PROJECT_ID + POSTHOG_PROJECT_API_KEY env vars).

**What changed in env config:**

- Added: `AGENTRY_ADMIN_URL`, `AGENTRY_ADMIN_TOKEN`.
- Removed: `POSTHOG_PROJECT_ID`, `POSTHOG_PROJECT_API_KEY`.
- Kept: `POSTHOG_HOST`, `POSTHOG_MASTER_API_KEY`, `POSTHOG_ORG_ID`.

**Trade-offs.**

- Pro: Iron-clad isolation via PostHog's own AST-level team_id enforcement. Same mechanism Enterprise customers pay for.
- Pro: All the regex-level wrap/blocklist complexity is gone. Free-form HogQL agents can write whatever (UNION, CTEs, subqueries, comments, JOINs to persons/groups tables) — PostHog wraps team_id around every events reference itself.
- Pro: New PostHog features auto-inherit team_id isolation.
- Con: One small additional service to operate (agentry-admin sidecar). 50 lines of Python + docker-compose + Caddy route. Restarts cleanly, has /health endpoint.
- Con: Direct Postgres INSERTs to PostHog's internal tables — technically going around the license check. PostHog's OSS code is MIT-licensed; the only paid feature this circumvents is the project-quota gate on the API. The team_id mechanism is identical between OSS and Enterprise.
- Con: PostHog upgrades that change the `posthog_team` schema would break the sidecar. Mitigation: pin PostHog versions on Hetzner; review schema before upgrades.

**Path to ratchet further if needed.**

If a future audit demands defense-in-depth beneath PostHog's HogQL enforcement (e.g., "what if PostHog has a bug in their compiler that misses a corner of HogQL syntax?"), the answer is ClickHouse-level row policies on top of this:

```sql
CREATE ROW POLICY events_per_team ON events
USING (team_id = getSetting('agentry_active_team_id'))
TO posthog_app;
```

…with the agentry-admin sidecar setting `agentry_active_team_id` per ClickHouse session. That's belt + suspenders below the HogQL compiler. Not done today — current isolation is what Enterprise customers run with.

---

## 2026-05-15 — Multi-tenant PostHog: shared-project + group wrap (not project-per-user)

**Problem.** PostHog self-hosted Open Source caps the org at 1 project. Discovered live by attempting to provision the third agentry user's PostHog project — got a 403 with `"You have reached the maximum limit of allowed projects for your current plan"`. The `agentry-user-<github_username>` project-per-user model that worked in dev fundamentally doesn't scale on OSS without an Enterprise license. Even worse: the failure mode wasn't surfacing to the agent cleanly — `forwardCapture` was returning 503 with `"user has no PostHog project provisioned"` and the agent's recovery path was "re-run agentry_login" (which mints a new api_key, churns the local config, and fails the SAME provisioning step on retry).

**Two independent issues stacked:**

1. **Architectural**: project-per-user collapses at PostHog OSS's 1-project cap.
2. **Operational**: the PostHog Rust `capture` service on the Hetzner VPS had exited 2 days prior (transient `kafka:9092` DNS failure → kafka-sink health check stalled → clean shutdown, no auto-restart). All `/capture/` endpoints returned Caddy 502. SSH'd in, restarted via `docker start henrikh-capture-1 henrikh-replay-capture-1` — both reconnected to Kafka. Documented for ops separately.

The architectural piece is the real decision below.

**Options considered.**

- **Option E — PostHog Enterprise license + revert to project-per-user.** PostHog's native multi-tenancy is `team_id`. Their HogQL compiler hardcodes `WHERE events.team_id = X` into every generated ClickHouse query — bulletproof at the SQL layer, no application-level filter dance. Cost: Enterprise self-hosted is paid (~$$ four-figure-monthly last we checked). The "right" answer if budget allows.

- **Option F — ClickHouse Row Policy.** ClickHouse supports `CREATE ROW POLICY ON events USING (...)` — applied below the SQL layer, can't be bypassed by query shape. *Conceptually* the gold standard. Operationally hard with PostHog: PostHog queries ClickHouse as a single service-account user, so row policies need either (a) per-user ClickHouse credentials (back to the provisioning problem), (b) session-variable-driven policies the Worker sets per query (PostHog's query API doesn't cleanly forward arbitrary CH settings), (c) a sidecar between agentry-api and PostHog that injects the session settings, or (d) forking PostHog's query compiler. Real engineering days; doable, but heavy.

- **Option A — Application-layer query rewriting.** All agentry users share one PostHog project; users are PostHog `groups` (`group_type='agentry_user'`, `group_key=<agentry user uuid>`). Events carry `$groups: {agentry_user: <userId>}` on capture; queries are rewritten by the Worker to scope each `events` scan to the user's group. Cheap to implement, no PostHog license, no ops surface — but the rewriting has to be airtight or it leaks across users.

**Decision.** Option A, hardened. Shipped in `f7923ee`, `7df7a68`, `af9d5a4`. The plan if/when commercial traction justifies it: graduate to Option E for ironclad isolation.

**The implementation, in order:**

**Phase 1 (`f7923ee`)** — refactor to shared-project model. New env: `POSTHOG_PROJECT_ID=1` (PostHog Default project), `POSTHOG_PROJECT_API_KEY` (the project's write key). `forwardCapture` injects `$groups: {agentry_user: userId}` on every event. `runHogQl` uses PostHog's `/api/projects/:id/query/` `filters.properties` block to inject a group filter, expecting PostHog to apply it server-side. `ensurePosthogForUser` becomes near-no-op + fires `$groupidentify` so the user shows up in PostHog's groups UI with a friendly name.

**Phase 2 (`7df7a68`)** — discovered the `filters.properties` block is silently dropped. Inspected the generated ClickHouse SQL in PostHog's query response: filter was nowhere in the WHERE clause. PostHog only honors `filters` when the HogQL explicitly references a `{filters}` template token. Switched to direct WHERE injection via string manipulation: find the top-level `WHERE`, inject `(properties.$group_0 = '<uid>') AND ` right after the keyword. UUID-validated at function entry — embedding it as a SQL literal is injection-safe.

**Phase 3 (`af9d5a4`)** — discovered the outer-WHERE injection had multiple bypasses. Demonstrated live:

1. *SQL line comment before WHERE.* `SELECT count() FROM events -- WHERE event='trickme'\nWHERE event='X'` — my regex found the WHERE inside the comment and injected the filter there. The actual WHERE on the next line was unfiltered. Total cross-user count returned.
2. *UNION ALL.* `SELECT … FROM events WHERE … UNION ALL SELECT … FROM events WHERE …` — only the first SELECT got the filter. Second SELECT exposed all users' events.
3. *Subquery / CTE.* Inner `FROM events` references inside subqueries or `WITH` clauses scanned cross-user data; the outer filter operated on the already-materialised subquery rows. Server-controlled recipes (which use CTEs heavily) were ALSO leaking because the same outer-only injection logic applied.

Rebuilt as a per-table-reference wrap:

```sql
FROM events           →   FROM (SELECT * FROM events WHERE properties.$group_0 = '<uid>')
FROM events e         →   FROM (SELECT * FROM events WHERE …) e
JOIN events AS e      →   JOIN (SELECT * FROM events WHERE …) AS e
```

Each `events` scan is independently scoped — UNION, CTEs, multi-FROM-events subqueries, JOINs all safely contained because the wrapping happens at the table-reference layer, not the outer query. Unified path for user queries AND recipes (`runHogQl` takes `opts: { trusted?: boolean }`; recipes pass `trusted: true` to skip the blocklist, but the wrap still applies).

The blocklist for *user-supplied* HogQL got narrower (the wrap handles more shapes):
- Block: SQL comments (`--`, `/* */`) — could confuse the regex.
- Block: any `FROM`/`JOIN` against a table other than `events` — PostHog's persons, groups, sessions, session_replay_events tables aren't isolated per agentry user, so referencing them is out.
- Allow: UNION, CTEs, subqueries (wrap handles all of them).

**Verified live against the running PostHog deployment:**
- UNION ALL with two SELECTs against `events`, both wrapped: returns `[[2], [2]]` for user A (whose count is 2). No leak from the second SELECT.
- CTE + JOIN to subquery on events, all wraps applied: returns 2 (user A's count). Inner CTE doesn't see other users.
- Cross-user spot-check: A → 2, B → 1, bogus UUID → 0.

**Known limitations.**
- String literals containing the substring `"FROM events"` get rewritten inside the literal. No security impact (the rewritten literal is just nonsensical and won't match anything), but the query may fail to match what the user intended. Edge case; agents don't typically search event names for the string `"FROM events"`.
- Regex-level table-reference matching can't handle every adversarial whitespace/casing edge case a determined attacker might craft. Untested attack surface exists. For a hostile multi-tenant SaaS context, this is *not* sufficient — graduate to Option E or F.
- The blocklist's "only events table" rule means cohort/funnel queries needing PostHog's `persons` or `groups` tables must go through recipes (server-controlled HogQL). Agents lose some ad-hoc flexibility there.

**When to graduate.**
- If agentry hosts data for users who don't trust each other → Option E (Enterprise + project-per-user) is the right move. PostHog's `team_id` enforcement is below the SQL layer; no regex maintenance.
- If you want both flexibility (free-form HogQL) AND iron-clad isolation without paying PostHog → Option F (ClickHouse row policy via session settings, plus a sidecar to forward them through PostHog).

**Why the wrap-approach lives in `apps/api/src/posthog.ts`, not as a more elegant AST rewrite.**
No JS HogQL parser exists. PostHog's parser is Python. Running it would mean spawning a process (no good in Cloudflare Workers) or porting it. The wrap is a pragmatic 4-line string regex. We tested every shape we could think of; it holds. If a future bypass is found, the response is patch + audit, not redesign.

**Capture-service outage postmortem (separate from the architectural decision but logged here for completeness).**
- 2026-05-13 17:15 UTC: docker network DNS resolved `kafka:9092` failed for ~25 s on the Hetzner box.
- PostHog Rust `capture` container's kafka-sink lifecycle monitor reported "health check stalled" → clean shutdown (exit code 0, OOMKilled false). No `restart: unless-stopped` policy attached.
- For 48 h: `/_health` returned 200 (Django/NGINX-Unit container still running), `/capture/` returned Caddy 502 (no upstream). Ingest 100 % dropped.
- 2026-05-15 08:37 UTC: SSH'd in, `docker start henrikh-capture-1 henrikh-replay-capture-1`. Both reconnected to Kafka in <1 s. Verified end-to-end.
- Follow-up: add `restart: unless-stopped` to the capture/replay-capture containers in the docker-compose so a transient DNS blip doesn't take ingest down for two days again. (Not done in this session — tracked separately.)

---

## 2026-05-13 — Data plane vs. compute plane: API stores, MCP transforms

**Problem.** As we add features (sourcemap unmangling, fingerprinting, formatting…) there's a fork in the road for every one: does the transformation run server-side (worker has the code) or agent-side (MCP runs it locally)? Without a rule, the codebase drifts toward "convenient on the server" — which means opaque blobs of compute the user can't review. That contradicts the agent-first wedge: the whole pitch is that the agent IS the SDK, not a vendor.

**Trigger.** Built server-side sourcemap unmangling (`apps/api/src/sourcemaps.ts` + `translateStack` hook in `GET /v1/cases/:id`). It worked, but it hid the translation logic inside a worker the user can't inspect — same anti-pattern as a vendor SDK, just relocated. User feedback was direct: "no magic. agent needs to be able to untangle itself, magical hidden pieces of code fuck that up." Reverted the server translator; moved translation to the MCP via `agentry_unmangle_stack` (uses `@jridgewell/trace-mapping` locally; code lives in `~/.npm/_npx/.../node_modules/@agentrysh/mcp/dist/`, reviewable per install).

**Decision.** Two-layer rule for every new feature:

- **HTTP API = data plane.** Storage, retrieval, deterministic queries. No opaque compute. Curl/CI/cron talks to this. If it changes the meaning of stored data, it doesn't belong here.
- **MCP = data plane + local compute.** Every HTTP route gets a 1:1 MCP tool wrapper (parity, so agents don't drop to bash for storage ops). Plus transformations that run in the agent's MCP process — code on npm, reviewable, version-pinned.

The two practical questions, applied to any new feature:
1. **Storage / retrieval / a query?** → HTTP API endpoint, then a 1:1 MCP tool wrapping it.
2. **A transformation that benefits from being review-able?** → MCP-only local compute. No HTTP equivalent. The user (and the agent) can read the exact code that produced the result, and reproduce it offline with the same library.

**Reference implementation (current):**
- `POST/GET/DELETE /v1/sourcemaps/{project_id}/` + `GET …/blob` — pure data plane, R2-backed.
- `agentry_upload_sourcemap / list_sourcemaps / delete_sourcemaps` — 1:1 MCP wrappers (parity).
- `agentry_unmangle_stack` — MCP-only compute. Fetches the blob via the data-plane endpoint, runs `@jridgewell/trace-mapping` locally, returns translated frames + the exact `code_snippet` that produced them + the library version.

**Why not put translation on the API as a convenience.** Was tempting (one call vs two). But the agent's extra tool call is cheap; the trust cost of hidden compute is not. The first time a translation returns "wrong" results and the user can't see how, the product is broken. Keeping all transforms in MCP also means we never have to support "the API translated it differently than the agent would have" — there's one translation path.

**Where this lives.** Encoded as a hard rule in `CLAUDE.md` so every future feature design hits it.

---

## 2026-05-13 — Pricing tiers, "event" definition, and observe-only metering

**Tiers (USD/mo, monthly events, retention):** Free 0 / 100k / 180d. Pro 39 / 1M / 365d. Scale 149 / 10M / 730d.

**What counts as an event.** One ingested record from any of `/v1/logs`, `/v1/track`, `/v1/deploys`, or the catch-all `/v1/log`. Agent queries (MCP reads) and outbound webhooks are **not** metered.

**Why ingest-only.** The cost we pay is storage × retention. Metering queries would create the wrong incentive — the agent would ration investigation to preserve quota, exactly when the user is in the value moment. Rate-limit reads at the API layer if needed; don't price them.

**No seats, no project limits.** Single-tenant-per-user model where the agent *is* the user. Free aggregates events across any number of projects — the scarce resource is total ingest volume, not project count.

**Retention as the wedge.** Floor at 6 months (Free) because "has this regressed before?" — the question agentry exists to answer — needs >30d history. Ceiling at 24mo (Scale); beyond that storage cost compounds faster than marginal value.

**Observe-only first.** `plan` column on `users` defaults to `free`. Limits are defined in `apps/api/src/plans.ts` but **not enforced at ingest**. Goal: see actual volume distributions for 1–2 months before deciding whether the gut-feel 100k/1M/10M tiers are right.

**Daily snapshots.** New `usage_snapshots(user_id, day, period, errors, analytics, deploys, total_events, plan)`. Cron at 01:10 UTC. Stores cumulative monthly counts as of snapshot time; per-day deltas computed at read time (with month-rollover reset). Lets us chart growth over time, which "right now" counters can't show.

**Admin surface.** `/admin/*` gated by `ADMIN_TOKEN` env secret — if unset, all admin routes 404 (don't advertise the surface). Endpoints: `GET /admin/usage` (cross-user current period), `GET /admin/usage/:user_id` (per-project breakdown), `GET /admin/usage/snapshots` (system-wide or per-user series), `POST /admin/usage/snapshot` (force run), `GET /admin/plans` (limits table), `PATCH /admin/users/:user_id/plan` (move a user).

**User-facing.** `GET /v1/usage` returns the authenticated user's current-period totals + plan limits + pct used. `GET /v1/usage/history?days=N` returns their snapshot series. Designed for the MCP agent to surface "you're at X% of plan" without round-tripping admin endpoints.

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

## 2026-05-12 — Agent-filed feedback channel

**Problem.** We have no way to learn what users want that agentry can't do today. Agents discover gaps silently — a missing tool, a recipe that doesn't fit, a UX dead-end — and the user reroutes without telling us. We need a structured channel.

**Decision.** Add a `feedback` table + `POST/GET /v1/feedback` + two MCP tools (`agentry_send_feedback`, `agentry_list_feedback`). Auth: API key (so feedback is tied to a user). The agent fires it in exactly two situations: (a) the user explicitly requests a feature or expresses frustration, (b) the agent has failed 2+ times at the same task. Tool description spells out both triggers and instructs the agent not to spam.

**Why not a separate datastore.** We already run Turso/libSQL via Drizzle. Spinning up a second store (CF D1, KV, separate Turso DB) would have meant double the operational surface for what is fundamentally one small table. Lean on the existing schema.

**Fields:** kind ∈ {missing_feature, bug, ux_friction, other}, message (user verbatim), agent_note (agent's own context), tool_name, attempt_count, project_id, claude_session_id. Plus resolved/resolution for triage.

**Operator view.** No dashboard. `agentry_list_feedback` (agent-first per our rule) and direct SQL on the underlying table are the two paths. If volume grows, the agent can build a dashboard the same way it builds any other surface — on top of the MCP.
