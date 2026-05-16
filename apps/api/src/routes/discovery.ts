import { Hono } from "hono";
import { buildInstallGuide, detectFramework } from "../install-guide.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

const QUERY_DOCS = `# agentry — agent query reference

agentry has no dashboard. You — the agent reading this — are the visualization layer.
Below is everything you need to answer questions like "how many users by cohort?" or
"show me the funnel drop-off" with a single HogQL or SQL query.

## Two query surfaces

1. **Recipes** — pre-baked queries with parameters and render hints. Use these first.
   - List: GET /v1/recipes (no auth)
   - Run:  POST /v1/projects/:id/recipes/:recipe_id/run  body: {params: {...}}
2. **Ad-hoc HogQL** — for anything the recipes don't cover.
   - POST /v1/projects/:id/analytics/query  body: {query: "<HogQL>"}

## When to render what

Recipes return a \`render_hint\`. Translate it like this:
- \`type: "table"\` → markdown table
- \`type: "line"\` / \`"bar"\` → markdown table + ASCII chart, or Mermaid pie/xychart
- \`type: "funnel"\` → 3-row table (step, count, drop-off %), compute drop-offs from
  consecutive counts: \`drop_n = 1 - (count_{n+1} / count_n)\`
- \`type: "scalar"\` → one-sentence summary
- \`type: "stacked_bar"\` → cohort heatmap if your UI supports it; markdown otherwise

## Analytics schema (PostHog, queried via HogQL)

Each customer has their own PostHog project, isolated from other customers.

### Table: \`events\`
| column | type | meaning |
|---|---|---|
| event | string | The event name (e.g. \`signup_completed\`, \`page_view\`). Required. |
| distinct_id | string | Stable per-user identifier. Agent-generated browser helper persists in localStorage. |
| timestamp | DateTime | When the event happened. |
| properties | Map<string, ?> | Arbitrary key/value sent with the event. |

Common properties on browser events (set by the agent-generated client helper):
- \`$current_url\`, \`$pathname\`, \`$referrer\`, \`$user_agent\`, \`$language\`

## HogQL primer

HogQL ≈ ClickHouse SQL. The most useful patterns:

\`\`\`sql
-- Time bucketing
SELECT toDate(timestamp) AS day, count() FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY day
SELECT toMonday(toDate(timestamp)) AS week, count() FROM events GROUP BY week

-- Distinct users
SELECT count(DISTINCT distinct_id) FROM events WHERE event = 'page_view'

-- Property access
SELECT properties.\$pathname AS path, count() FROM events GROUP BY path ORDER BY count() DESC

-- Funnels (manual)
WITH a AS (SELECT distinct_id, min(timestamp) AS t FROM events WHERE event = 'A' GROUP BY distinct_id),
     b AS (SELECT e.distinct_id FROM events e JOIN a ON a.distinct_id = e.distinct_id WHERE e.event = 'B' AND e.timestamp >= a.t)
SELECT (SELECT count() FROM a) AS step1, (SELECT count() FROM b) AS step2

-- Cohort retention skeleton
WITH signups AS (SELECT distinct_id, toMonday(toDate(min(timestamp))) AS cohort FROM events WHERE event = 'signup_completed' GROUP BY distinct_id)
SELECT cohort, count() FROM signups GROUP BY cohort ORDER BY cohort
\`\`\`

## Errors / cases / deploys schema (agentry's own DB)

These tables are queryable via the recipes that have \`backend: "cases"\`. To run an
ad-hoc SQL is not currently exposed — use recipes or the typed endpoints
(/v1/cases/:id, /v1/projects/:id/deploys, /v1/projects/:id/cases?status=open).

### \`cases\`
\`id\`, \`fingerprint\`, \`error_type\`, \`message\`, \`status\` (open|investigating|resolved|spurious|ignored),
\`event_count\`, \`first_seen_at\`, \`last_seen_at\`, \`last_deploy_sha\`, \`agent_summary\`, \`pr_url\`

### \`events\` (the agentry-side one — error events, not analytics)
\`id\`, \`fingerprint\`, \`error_type\`, \`message\`, \`stack\`, \`deploy_sha\`, \`environment\`, \`received_at\`

### \`deploys\`
\`id\`, \`sha\`, \`branch\`, \`environment\`, \`message\`, \`url\`, \`actor\`, \`received_at\`

## Tips for the agent

1. Try a recipe first. The 12 canonical recipes cover the questions humans actually ask.
2. If no recipe fits, use \`agentry_analytics_query\` with hand-rolled HogQL.
3. ALWAYS validate the rows match the user's question before rendering. If a metric
   looks suspicious, mention it (e.g. "DAU dropped to 0 on Tuesday — likely a tracking
   gap, not a real outage").
4. For visualization in chat: prefer markdown tables for accuracy and ASCII charts for
   shape. Use Mermaid only when the UI supports it. NEVER fabricate data.
`;

const AUTOMATION_DOCS = `# agentry — automation patterns

agentry's webhooks turn it from a query surface into a programmable platform. When
something interesting happens (new error, deploy, case resolution), agentry signs the
event and POSTs it to a URL you control. Your endpoint then does whatever — opens a
PR, posts to Slack, runs a Claude Agent SDK session, fires a downstream API call.

## Events

| event | when | data |
|---|---|---|
| \`case.created\` | first event of a new fingerprint lands | case_id, fingerprint, error_type, message, last_deploy_sha, first_seen_at |
| \`case.resolved\` | a case status flips to "resolved" | case_id, fingerprint, error_type, message, agent_summary, pr_url, last_deploy_sha |
| \`deploy.recorded\` | a deploy event is captured | deploy_id, sha, branch, environment, message, url, actor, received_at |

## Wire format

POST request to your URL with body:
\`\`\`json
{
  "event": "case.created",
  "delivered_at": 1736500000,
  "project_id": "...",
  "data": { ... event-specific ... }
}
\`\`\`

Headers:
- \`X-Agentry-Signature: t=<unix>,v1=<hex>\` — HMAC-SHA256(rawBody, signing_secret)
- \`X-Agentry-Webhook-Id: <wh_…>\`
- \`Content-Type: application/json\`

Verify in your endpoint:
\`\`\`ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody: string, header: string, secret: string): boolean {
  const m = header.match(/v1=([0-9a-f]+)/);
  if (!m || !m[1]) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(m[1], "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
\`\`\`

## Pattern: auto-fix on error (Cloudflare Worker template)

When a new case lands, spawn a Claude Agent SDK session that investigates and
opens a PR. Your endpoint just enqueues; the actual work runs async.

\`\`\`ts
// worker.ts — deploy with: wrangler deploy
import { createHmac, timingSafeEqual } from "node:crypto";

export default {
  async fetch(req: Request, env: { AGENTRY_WEBHOOK_SECRET: string; QUEUE: Queue<unknown> }) {
    const body = await req.text();
    const sig = req.headers.get("x-agentry-signature") ?? "";
    if (!verify(body, sig, env.AGENTRY_WEBHOOK_SECRET)) {
      return new Response("bad signature", { status: 401 });
    }
    const payload = JSON.parse(body);
    if (payload.event !== "case.created") return new Response("ignored", { status: 200 });
    // Fast 2xx — actual investigation runs in a queue consumer with the agent SDK.
    await env.QUEUE.send({ case_id: payload.data.case_id, project_id: payload.project_id });
    return new Response("ok", { status: 200 });
  },
};
\`\`\`

The queue consumer (a separate Worker / a Lambda / a long-lived service) calls
agentry_get_case to fetch the stack + recent_deploys, runs the Claude Agent SDK
to investigate the suspect file in the linked repo, opens a PR with the fix, and
calls agentry_resolve_case with the PR URL.

## Pattern: deploy regression alerts

Listen for \`deploy.recorded\`, then 30 minutes later run \`errors_after_last_deploy\`
recipe. If non-empty, post to Slack:

\`\`\`ts
if (payload.event === "deploy.recorded") {
  const sha = payload.data.sha;
  // Schedule a check 30 minutes later (Cloudflare Workers Cron / Durable Object alarm)
  await env.SCHEDULE.put(\`check-\${sha}\`, JSON.stringify({ at: Date.now() + 30 * 60_000 }));
}
\`\`\`

## Pattern: weekly digest

Cron-triggered (no webhook needed) — run agentry_run_recipe(weekly_review)
on a schedule, post the result to a Slack incoming-webhook URL.

## Pattern: open Linear issue on case threshold

Listen for \`case.created\`, store in a counter keyed on (project_id, day). When
the counter crosses your threshold, open a Linear issue with \`agentry_get_case\`
detail in the body.

## Tips

- Always 200 quickly — do real work async.
- Use the \`X-Agentry-Webhook-Id\` header for idempotency (de-dup if your queue
  re-delivers).
- Watch \`agentry_list_webhooks\` for last_status and last_error — agentry shows
  you when your endpoint is failing.
- For local dev, point the URL at \`http://localhost:8788/...\` running on
  \`wrangler dev --remote\` and tunnel with cloudflared (or use ngrok).
`;

// Canonical agent-readable reference. Served at /agentry.md (primary) and
// /llms.txt (back-compat alias). Designed so any LLM in any context can fetch
// it with one curl and have full working knowledge of agentry without
// installing anything. The MCP package is the accelerator; this doc is the
// always-available reference. Keep these in sync — both describe the same
// system from two angles.
//
// Split: /agentry.md = lean reference (always-relevant API + MCP surface).
//        /agentry-install.md = install + ops handbook (12-step install flow,
//        session replay, sourcemap deep dive, webhooks, recipes, privacy).
// During day-to-day usage the agent only needs the lean reference; during
// first-time install (or when configuring a new ops feature) it fetches
// the install handbook on demand. Splitting prevents the install boilerplate
// from bloating context after onboarding is done.
const AGENTRY_MD = `# agentry

Agent-first error monitoring + product analytics + deploy attribution.
The user's own AI agent (Claude Code, Cursor, Codex, Cline, Windsurf, or
any MCP-compatible client) investigates the data and writes the fixes.

There is no SaaS dashboard. There is no SDK to install. The user's agent
is the SDK.

> **First time installing agentry?** ALSO fetch /agentry-install.md. It has
> the 12-step install flow, session-replay strategies, sourcemap-upload
> details, webhook templates, recipes catalog, and privacy-disclosure
> snippets. This file is the lean day-to-day reference; the install doc is
> only needed during onboarding or when wiring a new ops feature.

## Canonical principle: data plane vs. compute plane

agentry has exactly two layers:

- **HTTP API at api.agentry.sh = data plane.**
  Storage, retrieval, deterministic queries. Cases, events, deploys,
  sourcemaps, recipes. The API never translates, normalizes, or rewrites
  anything — it stores what you POST and returns it on GET. Curl, CI, cron,
  anything HTTP-capable talks to this.

- **MCP package (@agentrysh/mcp on npm) = data plane wrapping + local compute.**
  Every HTTP endpoint has a 1:1 MCP tool wrapper (so agents don't drop to
  bash for storage). Plus tools that run TRANSFORMATIONS locally in the
  agent's MCP process — stack unmangling, fingerprinting, future ones.
  Transformation code lives on npm, reviewable in node_modules/@agentrysh/
  mcp/dist/, reproducible offline. No opaque server-side compute, ever.

When you read this doc, you can pick either path:
  - Use the MCP (\`claude mcp add agentry -- npx -y @agentrysh/mcp\`) for
    stateful, structured tool calls with cached auth.
  - OR use plain HTTP — every capability is reachable with curl + this doc.
    Slower per call (you handle auth yourself) but zero install.

## Two-prompt onboarding (with MCP)

\`\`\`
claude mcp add agentry -- npx -y @agentrysh/mcp
\`\`\`

Then in your agent: *"set me up with agentry"*. The agent runs the GitHub
device-code flow, mints both an api key (\`agk_…\`) and a public-dashboard
key (\`agp_…\`), provisions your PostHog project, creates an agentry project,
fetches the comprehensive install guide for your stack, walks the 12-step
install (errors + analytics + deploys, all three signal types in one pass),
and runs agentry_verify_install at the end. The full step-by-step belongs
to /agentry-install.md — fetch that file before starting the install.

## Two-prompt onboarding (without MCP, plain HTTP)

If you can't or don't want to install the MCP: every step in the install
flow is reachable via HTTP. The agent reads this doc + /agentry-install.md
+ /v1/install/guide and drives curl directly. See the "API surface" section
below.

## Signal types — three POSTs, one DSN

agentry is just HTTP. Three first-party endpoints, one DSN, same JSON
convention. All accept the DSN as \`Authorization: Bearer <DSN>\` (or as
x-sentry-auth / ?sentry_key= on the /v1/store/ alias).

| Endpoint                              | What lands here                          |
|---------------------------------------|------------------------------------------|
| POST /v1/logs/:project_id/            | Any structured event; errors are a subset |
| POST /v1/analytics/:project_id/       | Forwarded to your provisioned PostHog    |
| POST /v1/deploys/:project_id/         | Deploy events, attribute regressions     |

A log with name/message/stack gets fingerprinted and grouped into a Case
— that's what becomes a "bug" in the agent's mental model.

### Sentry / PostHog compat aliases (drop-in for existing fleets)

- POST /v1/store/:project_id/   → Sentry-wire-protocol alias for /v1/logs/
- POST /v1/track/:project_id/   → PostHog-shaped alias for /v1/analytics/
- POST /v1/log/:project_id/     → catch-all that auto-detects kind by shape

ALL outbound HTTP MUST set a custom \`user-agent\` header. Cloudflare's
Browser Integrity Check 403s default Python-urllib / Java HttpClient UAs
with CF error 1010. Helper code in agentry_install_guide always sets one.

## Install flow (summary)

agentry has no SDK by design. The agent generates a ~25-line fetch helper
at install time and instruments errors + analytics + deploys in one pass.
The full 12-step checklist (helper code, framework wiring, event inventory
lens selection, sourcemap upload, privacy clause, verify-install) lives in
/agentry-install.md. Fetch it when installing.

## Cases — the bug primitive

Multiple events with the same fingerprint collapse into one Case. Cases
have status (open / investigating / resolved / spurious / ignored) and
attribute to deploys via last_deploy_sha. The agent investigates cases by:

- GET /v1/cases/:id → stack + breadcrumbs + recent_deploys + affected_users
- If stack frames look minified, call **agentry_unmangle_stack** (MCP tool,
  see "Sourcemaps" below) to translate locally
- Cross-reference last_deploy_sha with recent_deploys[] to identify the
  suspect deploy
- git log + git blame from local_path to find the regression
- Open a PR; PATCH /v1/cases/:id with status=resolved + summary + pr_url

Suppress noise via POST /v1/projects/:id/suppressions — pattern + action
(auto_ignore / auto_resolve / prompt_hint).

For minified client-side stacks, call \`agentry_unmangle_stack(case_id)\` —
it's an MCP-side compute tool that pulls each frame's .map from agentry's
sourcemap blob endpoint and translates it locally via @jridgewell/trace-
mapping. Sourcemap uploads, webhook plumbing, recipe runs, session-replay
config and privacy disclosure all live in /agentry-install.md.

## Three tokens, sharp blast radius each

agentry uses three different token formats. They are NOT interchangeable.
Knowing which one to ship where is the single most important security
decision the agent makes during install.

| Token                  | Format                       | Auths                                                                | Safe in SPA bundle? | Mint / rotate via              |
|------------------------|------------------------------|----------------------------------------------------------------------|----------------------|--------------------------------|
| Private API key        | \`agk_…\`                      | Every owner-side endpoint (cases, deploys, projects, mint DSNs, mint publications) | **NO** — server / agent only. | \`agentry_login\` / \`agentry_rotate_key\` |
| Public dashboard key   | \`agp_…\`                      | ONLY \`GET /v1/public/q/<publication_id>?key=agp_…\` for publications you explicitly minted | YES — read-only, schema bounded by the recipe + params. | minted alongside \`agk_\` at first login |
| Project DSN            | \`agnt_<projectId>.<token>\`   | ONLY the three ingest endpoints (\`/v1/logs/\`, \`/v1/analytics/\`, \`/v1/deploys/\`) for ONE project | YES — ingest-only, no readback. | \`agentry_create_project\` |

**Blast radius if leaked:**

- \`agk_\` leak → full account compromise. Rotate immediately via
  \`agentry_rotate_key\` (revokes the old key).
- \`agp_\` leak → visitors can re-fetch the publications you already chose
  to publish. Nothing else. Revoke individual publications with
  \`agentry_revoke_publication\` (no need to re-mint the key).
- DSN leak → an attacker can forge events on that ONE project (no read,
  no cross-project bleed). Rotate the project's DSN.

**Where each goes:**

- SPA / mobile bundle, public marketing site: **DSN** for ingest (errors,
  analytics, deploy pings) + **\`agp_\`** for any embedded chart. Both are
  meant to be shippable.
- Dev machine (\`~/.agentry/config.json\` — written by MCP), CI secret store,
  agent-driven webhooks: **\`agk_\`**. Nothing else.

The publishable-query flow uses both: the agent runs a recipe + decides
"this rendering is shareable" → calls \`agentry_publish_query\` with
project_id + recipe_id + params. agentry returns a \`publication_id\` and
an \`embeddable_url\` of the form
\`https://api.agentry.sh/v1/public/q/<publication_id>?key=agp_…\` with open
CORS — fetchable directly from any browser page. Anyone GET-ing that URL
gets the recipe's rows. Revoke any time with \`agentry_revoke_publication\`.

## API surface (complete)

### Auth (no key required)

- POST /v1/auth/device                            → start GitHub device flow
- POST /v1/auth/device/poll   {device_code}       → poll for completion
                                                    returns {api_key, public_api_key, public_api_key_prefix, user_id, github, posthog}

### Auth (api-key required: \`Authorization: Bearer <agk_…>\`)

- POST   /v1/auth/keys/rotate                     → mint new private key, revoke current
- POST   /v1/projects                             → create project; returns DSN + helper URLs
- GET    /v1/projects
- GET    /v1/projects/:id
- GET    /v1/projects/:id/cases?status=open
- GET    /v1/cases/:id                            → case detail with recent_deploys
- PATCH  /v1/cases/:id                            → update status / summary / pr_url
- POST   /v1/cases/:id/runs                       → record agent investigation run
- POST   /v1/projects/:id/suppressions
- GET    /v1/projects/:id/suppressions
- GET    /v1/projects/:id/deploys?limit=20&since=<unix>
- POST   /v1/projects/:id/analytics/query         → HogQL (PostHog passthrough)
- POST   /v1/projects/:id/webhooks                → register webhook
- GET    /v1/projects/:id/webhooks
- DELETE /v1/projects/:id/webhooks/:id
- POST   /v1/projects/:id/public-queries          → mint a publication (returns publication_id + embeddable_url)
- GET    /v1/projects/:id/public-queries          → list publications
- DELETE /v1/projects/:id/public-queries/:pub_id  → revoke publication
- POST   /v1/projects/:id/posthog/session-replay/configure  → set replay strategy
- GET    /v1/projects/:id/posthog/session-replay/status     → current config + web UI URL
- GET    /v1/projects/:id/feature-flags                     → list flags
- POST   /v1/projects/:id/feature-flags                     → create flag
- GET    /v1/projects/:id/feature-flags/:flag_id            → get flag
- PATCH  /v1/projects/:id/feature-flags/:flag_id            → update flag
- DELETE /v1/projects/:id/feature-flags/:flag_id            → soft-delete flag
- GET    /v1/projects/:id/cohorts                           → list cohorts
- POST   /v1/projects/:id/cohorts                           → create cohort
- GET    /v1/projects/:id/cohorts/:cohort_id                → get cohort
- DELETE /v1/projects/:id/cohorts/:cohort_id                → soft-delete cohort
- GET    /v1/projects/:id/surveys                           → list surveys
- POST   /v1/projects/:id/surveys                           → create survey
- GET    /v1/projects/:id/surveys/:survey_id                → get survey
- DELETE /v1/projects/:id/surveys/:survey_id                → delete survey
- GET    /v1/projects/:id/session-replays                   → list recordings (filter by distinct_id/date)
- GET    /v1/projects/:id/session-replays/:replay_id        → recording metadata + player URL

### Public dashboard (no api key required; \`?key=agp_…\` only, open CORS)

- GET /v1/public/q/:publication_id?key=agp_…     → execute bound recipe, return rows

### DSN-authenticated (project-scoped, Bearer DSN or x-sentry-auth)

- POST /v1/logs/:project_id/         → log/error ingest
- POST /v1/analytics/:project_id/    → analytics event ingest
- POST /v1/deploys/:project_id/      → deploy ingest
- POST /v1/store/:project_id/        → Sentry-wire alias for /v1/logs/
- POST /v1/track/:project_id/        → PostHog-shape alias for /v1/analytics/
- POST /v1/log/:project_id/          → catch-all (auto-detect kind)
- POST /v1/sourcemaps/:project_id/   → upload .map blob
- GET  /v1/sourcemaps/:project_id/   → list
- GET  /v1/sourcemaps/:project_id/blob   → fetch raw .map
- DELETE /v1/sourcemaps/:project_id/?release_id=…

### Discovery (no auth)

- GET /                                          → service metadata
- GET /agentry.md                                → this file (lean reference)
- GET /agentry-install.md                        → install + ops handbook
- GET /llms.txt                                  → alias of /agentry.md
- GET /v1/install/guide?framework=…              → category-aware install checklist
- GET /v1/install/sdk/{node,browser}             → fetch-helper snippet
- GET /v1/recipes                                → analytics recipe catalog
- GET /v1/docs/query                             → HogQL primer
- GET /v1/docs/automation                        → webhook handler templates
- GET /v1/privacy/disclosure?variant=…           → paste-ready policy clauses

CORS is enabled on all DSN-authenticated ingest endpoints (Access-Control-
Allow-Origin: *) since they're auth-scoped, and on /v1/public/q/* (which
authenticates via the embedded \`agp_…\` token). Other endpoints reject
browser origins — they're MCP-only.

## MCP tool reference (when you have it installed)

Every HTTP capability above has a corresponding MCP tool. The MCP also
adds local-compute tools that don't exist on the API by design.

| Tool                            | Wraps / does                              |
|---------------------------------|-------------------------------------------|
| agentry_status                  | local config state + suggested next action |
| agentry_login                   | GitHub device flow — mints \`agk_\` + \`agp_\` keys |
| agentry_rotate_key              | rotate private api key                    |
| agentry_create_project          | POST /v1/projects                         |
| agentry_publish_query           | POST /v1/projects/:id/public-queries — returns embeddable_url |
| agentry_list_publications       | GET /v1/projects/:id/public-queries       |
| agentry_revoke_publication      | DELETE /v1/projects/:id/public-queries/:pub_id |
| agentry_list_projects           | GET /v1/projects                          |
| agentry_list_cases              | GET /v1/projects/:id/cases                |
| agentry_get_case                | GET /v1/cases/:id                         |
| agentry_resolve_case            | PATCH /v1/cases/:id status=resolved       |
| agentry_mark_spurious           | PATCH + optional suppression              |
| agentry_record_suppression      | POST /v1/projects/:id/suppressions        |
| agentry_unmangle_stack          | **LOCAL** — translates minified stack via @jridgewell/trace-mapping |
| agentry_install_sdk             | GET /v1/install/sdk/{lang}                |
| agentry_install_guide           | GET /v1/install/guide                     |
| agentry_verify_install          | fires synthetic error/analytics/deploy events, reports OK/FAIL per signal |
| agentry_capture_test_event      | POST /v1/store/ with a synthetic exception |
| agentry_track_test_event        | POST /v1/track/ with a synthetic event    |
| agentry_record_deploy           | POST /v1/deploys/                         |
| agentry_list_deploys            | GET /v1/projects/:id/deploys              |
| agentry_analytics_query         | POST /v1/projects/:id/analytics/query     |
| agentry_list_recipes            | GET /v1/recipes                           |
| agentry_run_recipe              | POST /v1/projects/:id/recipes/:id/run     |
| agentry_query_docs              | GET /v1/docs/query                        |
| agentry_automation_docs         | GET /v1/docs/automation                   |
| agentry_suggested_next_steps    | composed recommendation based on local state |
| agentry_project_health          | aggregated stats across recent events / cases |
| agentry_remember / agentry_recall | agent-private notes file in ~/.agentry/ |
| agentry_register_webhook        | POST /v1/projects/:id/webhooks            |
| agentry_list_webhooks           | GET /v1/projects/:id/webhooks             |
| agentry_delete_webhook          | DELETE /v1/projects/:id/webhooks/:id      |
| agentry_test_webhook            | POST /v1/projects/:id/webhooks/:id/test   |
| agentry_create_alert            | wraps webhook + filter for threshold-based alerts |
| agentry_list_alerts             | GET alerts                                |
| agentry_evaluate_alert          | LOCAL — runs alert filter against recent data |
| agentry_delete_alert            | DELETE                                    |
| agentry_upload_sourcemap        | POST /v1/sourcemaps/:id/                  |
| agentry_list_sourcemaps         | GET /v1/sourcemaps/:id/                   |
| agentry_delete_sourcemaps       | DELETE /v1/sourcemaps/:id/                |
| agentry_configure_session_replay | POST /v1/projects/:id/posthog/session-replay/configure |
| agentry_session_replay_status   | GET /v1/projects/:id/posthog/session-replay/status |
| agentry_list_feature_flags      | GET /v1/projects/:id/feature-flags        |
| agentry_get_feature_flag        | GET /v1/projects/:id/feature-flags/:id    |
| agentry_create_feature_flag     | POST /v1/projects/:id/feature-flags       |
| agentry_update_feature_flag     | PATCH /v1/projects/:id/feature-flags/:id  |
| agentry_delete_feature_flag     | soft-delete a feature flag (PATCH deleted=true) |
| agentry_list_cohorts            | GET /v1/projects/:id/cohorts              |
| agentry_get_cohort              | GET /v1/projects/:id/cohorts/:id          |
| agentry_create_cohort           | POST /v1/projects/:id/cohorts             |
| agentry_delete_cohort           | soft-delete a cohort                      |
| agentry_list_surveys            | GET /v1/projects/:id/surveys              |
| agentry_get_survey              | GET /v1/projects/:id/surveys/:id          |
| agentry_create_survey           | POST /v1/projects/:id/surveys             |
| agentry_delete_survey           | DELETE /v1/projects/:id/surveys/:id       |
| agentry_list_session_replays    | GET /v1/projects/:id/session-replays (filter by distinct_id / date) |
| agentry_get_session_replay      | GET /v1/projects/:id/session-replays/:id (returns player_url) |
| agentry_list_event_names        | grouped list of analytics events seen     |
| agentry_list_feedback           | feedback channel for agent-filed gaps     |
| agentry_send_feedback           | file a missing-feature / friction report  |

## Errors

Every error response has the same envelope:

\`\`\`json
{"error": {"code": "...", "message": "...", "next_action": "..."}}
\`\`\`

Codes include: invalid_payload, unauthorized, invalid_api_key, invalid_dsn,
not_found, forbidden, rate_limited, payload_too_large, posthog_capture_failed,
analytics_not_configured, internal.

The \`next_action\` field is what the agent should do next — read it; don't
fall back to your own retry guess.

## Where to read the source

- HTTP API (the data plane): code lives in agentry-public on GitHub. Audit
  every transformation by reading apps/api/src/.
- MCP (the data plane wrapper + local compute): @agentrysh/mcp on npm, with
  source mirrored to agentry-public. Read ~/.npm/_npx/.../@agentrysh/mcp/
  dist/tools.js for the exact code your agent runs.

No magic. Everything that runs is text you can grep.
`;

// Install + ops handbook. Fetched on demand during first-time setup and
// when configuring a new ops feature (session replay, webhooks, sourcemap
// upload). Split out from /agentry.md so the lean reference can stay
// resident in agent context without dragging install boilerplate along.
const AGENTRY_INSTALL_MD = `# agentry — install & ops handbook

This is the deep companion to /agentry.md. Fetch it once at install time
and again only when configuring a new ops feature (sourcemaps, session
replay, webhooks). Day-to-day tool calls don't need this file in context.

agentry has no SDK by design. The agent generates a ~25-line fetch helper
at install time, tuned to the stack, and instruments errors + analytics +
deploys in ONE pass — NOT three separate sessions.

## The install flow (12 steps, run by the agent)

1. \`investigate_app_structure\` — read the repo. Pick a product category
   (SaaS / e-commerce / marketplace / content-media / dev-tool / games /
   internal-tool / single-purchase / open-source / enterprise-sales) and a
   metrics lens (AARRR by default; HEART, North Star, DAU+Stickiness, B2B
   funnel, PLG, JTBD, API-tool, Marketplace as alternatives). Write the
   answers to agentry_memory.md so subsequent steps are grounded.

2. \`do_not_use_sentry_sdk\` — agentry's DSN is \`agnt_<projectId>.<token>\`,
   NOT a Sentry DSN. sentry_sdk.init() rejects it (BadDsn). Use the helper.

3. \`install_http_lib\` — pip install requests / gem install / etc. as
   needed by the language.

4. \`set_env_vars\` — AGENTRY_DSN, AGENTRY_URL, GIT_SHA (read from
   GITHUB_SHA / VERCEL_GIT_COMMIT_SHA / RENDER_GIT_COMMIT / etc.).

5. \`drop_in_helper\` — paste the ~25-line fetch helper into src/lib/agentry.
   The helper has agentry.send("logs"|"analytics"|"deploys", payload).
   Source: GET /v1/install/sdk/{node,browser} for paste-ready snippets.

6. **REQUIRED** \`wire_errors\` — framework-level error handler forwarding
   uncaught exceptions to agentry.send("logs", exc).

7. **REQUIRED** \`inventory_events_by_lens\` — build a 15–25+ event
   inventory grouped by the chosen lens's layers (AARRR: Acquisition /
   Activation / Retention / Referral / Revenue). If a payment processor
   exists, REVENUE has 5+ events minimum.

8. **REQUIRED** \`wire_analytics_events\` — instrument every event in the
   inventory. Rich properties (plan, source, variant, ids, amounts).

9. **REQUIRED** \`wire_deploy_capture\` — startup-time deploy ping reading
   GIT_SHA, OR CI step POSTing to /v1/deploys/.

10. \`upload_sourcemaps_for_minified_stacks\` (client frameworks only) —
    curl loop in CI POSTing each .map to /v1/sourcemaps/{project}/. agentry
    stores; agent translates locally via agentry_unmangle_stack.

11. \`update_privacy_policy\` — paste-ready clause from /v1/privacy/disclosure.

12. \`verify_install\` — must pass ALL THREE signal types (errors,
    analytics, deploys) before the install counts as done. No partial
    installs.

After verify, the agent runs \`checkin_with_user\` ONCE (the only place in
the install where it asks a question — confirms inventory coverage, flags
ambiguities). Then \`suggest_next_builds\` proposes 3–5 dashboards /
automations tailored to the actual event inventory.

## Sourcemaps — server stores, agent translates

Client-side errors arrive with minified stacks (\`at t.a (chunks/abc.js:1:1234)\`).
The agent translates them LOCALLY using sourcemaps stored on agentry.

Storage (data plane, HTTP API):

- POST   /v1/sourcemaps/{project_id}/?release_id=<sha>&source_url=<path>
  Body: raw .map JSON. Auth: Bearer DSN. Stores in R2 keyed by the tuple.
- GET    /v1/sourcemaps/{project_id}/?release_id=<sha>   → list uploads
- GET    /v1/sourcemaps/{project_id}/blob?release_id=<sha>&source_url=<path>
  → returns raw .map JSON, ready to feed to a source-map library
- DELETE /v1/sourcemaps/{project_id}/?release_id=<sha>   → clean up old release

Translation (compute plane, MCP-only):

- \`agentry_unmangle_stack(case_id)\` → fetches every minified frame's .map
  via the blob endpoint, runs @jridgewell/trace-mapping (open source, on
  npm) locally in the MCP process, returns translated frames + the exact
  4-line code snippet that produced them + the library version. Reproducible
  offline.

Translation NEVER runs on the server. The agent (or you) can verify by
reading ~/.npm/_npx/<hash>/node_modules/@agentrysh/mcp/dist/tools.js — the
unmangle handler is right there.

## Session replay (PostHog) — OPT-IN, agent-driven strategy

agentry's per-user PostHog team supports session replay (the full PostHog
OSS feature: video-like reconstruction of a user's browser session). It's
OFF by default. The agent enables it on the user's request, with one of:

| Strategy        | What it does                                                           | Storage cost |
|-----------------|------------------------------------------------------------------------|--------------|
| \`off\`           | No new recordings.                                                     | None         |
| \`all\`           | 100% sampling — every session.                                         | Heavy        |
| \`sampled\`       | Random sample at \`sample_rate\` (default 0.1). Good cost/coverage.    | Medium       |
| \`url_scoped\`    | Only sessions hitting URLs in \`url_triggers\`. Best for funnels.      | Light        |
| \`errors_only\`   | No automatic sampling; recording starts JIT when the customer's app    | Lightest     |
|                 | calls \`posthog.startSessionRecording()\` (e.g. inside captureError).    |              |

The agent's job:
  1. ASK the user which strategy fits their app + storage tolerance.
  2. Call \`agentry_configure_session_replay\` with the choice + retention.
  3. For \`errors_only\`: also edit the customer's agentry helper (from the
     install guide's drop_in_helper) to call \`posthog.startSessionRecording()\`
     inside captureError. Recording starts on the next user error.

Endpoints (api-key auth, project-scoped):
- POST /v1/projects/:id/posthog/session-replay/configure
    body: {strategy, sample_rate?, retention_days?, min_duration_ms?, url_triggers?}
- GET  /v1/projects/:id/posthog/session-replay/status
    returns the current config + \`web_ui_url\` deep-link into PostHog's
    Replay tab for viewing recordings.

Retention is controlled per-team via \`retention_days\` (30 / 90 / 365).
Recordings older than this are deleted by PostHog automatically — no agentry
cron required.

Currently the agentry MCP can't retrieve recordings programmatically
(\`session_recording:read\` scope isn't on the master Personal API Key).
Until that's widened, use the \`web_ui_url\` returned by
\`agentry_session_replay_status\` to view recordings in PostHog's browser UI.
Once expanded, \`agentry_get_session_replays(case_id)\` will return playable
URLs the agent can surface alongside cases for one-click debugging.

## Feature flags / cohorts / surveys / A/B testing (PostHog)

Full PostHog feature parity on every per-user team. As of 2026-05-15, all
of these have dedicated MCP tools — the master Personal API Key has \`*\`
scope so the agent can list / create / update / delete each resource
directly without dropping to the web UI.

### Feature flags

| Tool                            | What it does                                                                  |
|---------------------------------|-------------------------------------------------------------------------------|
| \`agentry_list_feature_flags\`    | List all flags on the project. Each has \`id\`, \`key\`, \`name\`, \`active\`, \`filters\`. |
| \`agentry_get_feature_flag\`      | Full configuration for one flag (filters, variants, conditions).              |
| \`agentry_create_feature_flag\`   | Simple shape: \`{key, name?, active?, rollout_percentage?}\`. Advanced: pass full \`filters\` for property-targeted / multivariate / cohort-scoped flags. |
| \`agentry_update_feature_flag\`   | Patch \`active\`, \`name\`, \`rollout_percentage\`, or \`filters\`.               |
| \`agentry_delete_feature_flag\`   | Soft-delete (recoverable in PostHog's web UI).                                |

Reading the flag value in customer code uses PostHog's standard SDKs
(\`posthog.isFeatureEnabled('key')\`, \`posthog.getFeatureFlag('key')\`).
agentry doesn't ship a feature-flag evaluation client — the customer's
PostHog-JS / Python / Node SDK does the work, talking to their per-user
team's PostHog endpoint.

### Cohorts

| Tool                    | What it does                                                       |
|-------------------------|--------------------------------------------------------------------|
| \`agentry_list_cohorts\`  | List cohorts (dynamic user segments).                              |
| \`agentry_get_cohort\`    | One cohort's filter + last calculation + count.                    |
| \`agentry_create_cohort\` | Simple: \`{name, event, days?}\` — users who fired \`event\` in last N days. Advanced: \`{name, groups: [...PostHog filter format]}\`. |
| \`agentry_delete_cohort\` | Soft-delete.                                                       |

Cohorts compose with feature flags (target a rollout to a cohort) and
HogQL (\`SELECT … WHERE person_id IN (SELECT person_id FROM cohort_people
WHERE cohort_id = N)\`).

### Surveys

| Tool                    | What it does                                                                   |
|-------------------------|--------------------------------------------------------------------------------|
| \`agentry_list_surveys\`  | List surveys (NPS, CSAT, custom popups).                                       |
| \`agentry_get_survey\`    | One survey's definition + appearance config + linked flag.                     |
| \`agentry_create_survey\` | Quick: \`{name, question, question_type?}\` for single-question popover. Multi: \`{name, questions: [...]}\`. Created in draft — pass \`start_date\` (ISO) to launch immediately. |
| \`agentry_delete_survey\` | Hard-delete.                                                                   |

Responses land as \`survey sent\` events. To read them:

\`\`\`sql
SELECT properties.\\$survey_response, properties.\\$survey_iteration
FROM events
WHERE event = 'survey sent' AND properties.\\$survey_id = '<id>'
ORDER BY timestamp DESC
\`\`\`

### Session replay retrieval

Once replay is enabled (via \`agentry_configure_session_replay\`), use
these to find and inspect recordings:

| Tool                            | What it does                                                                                |
|---------------------------------|---------------------------------------------------------------------------------------------|
| \`agentry_list_session_replays\`  | Filter by \`distinct_id\` (the user from a case's affected_users), \`date_from\`, \`date_to\`. |
| \`agentry_get_session_replay\`    | Returns \`player_url\` — open in browser to watch. Snapshot bytes via curl + master key if you want to inspect DOM events programmatically. |

Killer workflow: when investigating an error, grab \`affected_users[].distinct_id\`
from \`agentry_get_case\`, pass it to \`agentry_list_session_replays\`, and
the player URL of the recording leading up to the error is one tool call away.

## Webhooks — push events to your code

agentry doesn't run automation; you do. Register a webhook, agentry POSTs
your URL on case.created / case.resolved / deploy.recorded.

- POST   /v1/projects/:id/webhooks   {url, events?, description?}  → {id, signing_secret} (shown once)
- GET    /v1/projects/:id/webhooks
- DELETE /v1/projects/:id/webhooks/:id
- POST   /v1/projects/:id/webhooks/:id/test       → fires a synthetic ping
- GET    /v1/docs/automation                      → paste-ready Worker templates

Body is signed with HMAC-SHA256; verify via the X-Agentry-Signature header.

## Recipes — canned analytics queries

For the most-asked questions, agentry ships pre-built HogQL/SQL templates.

- GET  /v1/recipes                                  → list catalog (no auth)
- GET  /v1/recipes/:id                              → full HogQL template
- POST /v1/projects/:project_id/recipes/:id/run     → rows + render_hint

Categories: DAU/cohorts/retention, 3-step funnels with drop-offs, top
events, event time-series, conversion rates, top open errors, errors-per-
hour, errors after last deploy, deploy frequency.

When no recipe matches, the agent composes HogQL directly:

- POST /v1/projects/:project_id/analytics/query  {query: "<HogQL>"}
- GET  /v1/docs/query   → HogQL primer (schema, common patterns)

## Public dashboards — publish a recipe with the \`agp_\` key

Use \`agentry_publish_query\` to bind a (recipe, params) tuple to a
publication_id. The returned \`embeddable_url\` (form
\`https://api.agentry.sh/v1/public/q/<publication_id>?key=agp_…\`) is safe
to drop into a public marketing site or status page — open CORS, no
\`Authorization\` header needed. The \`agp_…\` token only authenticates that
endpoint; visitors can't reach cases, deploys, raw events, or arbitrary
HogQL. Revoke any time with \`agentry_revoke_publication\`.

## Privacy disclosure

- GET /v1/privacy/disclosure?variant=client|server&errors=true&analytics=true
  Paste-ready privacy-policy clauses for the agent to merge into the customer's
  privacy policy. agentry.sh is the canonical link; customers' policies pointing
  here serve as honest backlinks.

## Back to the lean reference

When install is done, day-to-day usage only needs /agentry.md — it has the
full API surface, MCP tool table, and case-investigation flow without
dragging this install boilerplate along.
`;

router.get("/", (c) => {
  return c.json({
    name: "agentry",
    version: "0.0.0",
    docs: "/agentry.md",
    install_docs: "/agentry-install.md",
    next_action:
      "Read /agentry.md for the day-to-day API + MCP reference. If installing " +
      "agentry for the first time, ALSO fetch /agentry-install.md for the " +
      "12-step setup checklist + ops handbook. Then install the MCP for stateful " +
      "tooling (`claude mcp add agentry -- npx -y @agentrysh/mcp`) OR drive " +
      "everything via plain HTTP using the API surface in the doc.",
  });
});

// /agentry.md is the canonical agent-readable reference. /agentry-install.md
// is the install + ops handbook companion (separate file so day-to-day context
// stays lean). /llms.txt is kept as a back-compat alias for the lean reference
// (the convention name some agents look for by default).
router.get("/agentry.md", (c) => {
  return c.text(AGENTRY_MD, 200, { "content-type": "text/markdown; charset=utf-8" });
});
router.get("/agentry-install.md", (c) => {
  return c.text(AGENTRY_INSTALL_MD, 200, { "content-type": "text/markdown; charset=utf-8" });
});
router.get("/llms.txt", (c) => {
  return c.text(AGENTRY_MD, 200, { "content-type": "text/plain; charset=utf-8" });
});

router.get("/v1/install/guide", (c) => {
  const framework = detectFramework(c.req.query("framework"));
  const sigParam = c.req.query("signal_types");
  const signalTypes = sigParam
    ? sigParam.split(",").map((s) => s.trim()).filter(Boolean)
    : ["errors", "analytics", "deploys"];
  return c.json(buildInstallGuide(framework, signalTypes));
});

// Server-side JS helper. No `import { agentry } from '@agentry/node'` — agentry
// has NO SDK by design. This is a ~30-line fetch-based helper the agent pastes
// into the customer's repo at `src/lib/agentry.ts`. Same shape as the helpers
// for python/ruby/go/etc. Three POST endpoints, no client library to vet.
router.get("/v1/install/sdk/node", (c) => {
  const code =
    "// src/lib/agentry.ts — server-side, native fetch (Node 20+), no deps.\n" +
    "const URL = process.env.AGENTRY_URL!;\n" +
    "const DSN = process.env.AGENTRY_DSN!;\n" +
    "const PID = DSN.split('_')[1].split('.')[0];\n" +
    "const GIT_SHA = process.env.GIT_SHA\n" +
    "  ?? process.env.VERCEL_GIT_COMMIT_SHA\n" +
    "  ?? process.env.RENDER_GIT_COMMIT\n" +
    "  ?? process.env.HEROKU_SLUG_COMMIT\n" +
    "  ?? 'unknown';\n" +
    "const ENV = process.env.NODE_ENV ?? 'production';\n" +
    "\n" +
    "type Kind = 'logs' | 'analytics' | 'deploys';\n" +
    "\n" +
    "export async function agentry(kind: Kind, payload: object): Promise<void> {\n" +
    "  try {\n" +
    "    await fetch(`${URL}/v1/${kind}/${PID}/`, {\n" +
    "      method: 'POST',\n" +
    "      headers: {\n" +
    "        authorization: `Bearer ${DSN}`,\n" +
    "        'content-type': 'application/json',\n" +
    "        'user-agent': 'agentry-node/1.0',\n" +
    "      },\n" +
    "      body: JSON.stringify(payload),\n" +
    "    });\n" +
    "  } catch { /* never let monitoring crash the request */ }\n" +
    "}\n" +
    "\n" +
    "export function captureError(err: unknown, extra?: object): Promise<void> {\n" +
    "  const e = err instanceof Error ? err : new Error(String(err));\n" +
    "  return agentry('logs', {\n" +
    "    name: e.name, message: e.message, stack: e.stack,\n" +
    "    environment: ENV, deploy_sha: GIT_SHA, extra,\n" +
    "  });\n" +
    "}\n" +
    "\n" +
    "export function track(event: string, distinct_id: string,\n" +
    "                     properties: Record<string, unknown> = {}): Promise<void> {\n" +
    "  return agentry('analytics', { event, distinct_id, properties });\n" +
    "}\n" +
    "\n" +
    "// At your app's main entrypoint, AFTER importing the helper:\n" +
    "process.on('uncaughtException', (err) => captureError(err, { uncaught: true }));\n" +
    "process.on('unhandledRejection', (err) => captureError(err, { unhandled: true }));\n";

  return c.json({
    language: "node",
    code,
    required_env: ["AGENTRY_URL", "AGENTRY_DSN", "GIT_SHA"],
    next_action:
      "Paste into src/lib/agentry.ts. Set AGENTRY_DSN + AGENTRY_URL env vars. " +
      "Then call agentry_install_guide for the full instrumentation checklist " +
      "(events to track, deploy attribution, sourcemap upload).",
  });
});

router.get("/v1/docs/query", (c) => {
  return c.text(QUERY_DOCS, 200, { "content-type": "text/markdown; charset=utf-8" });
});

router.get("/v1/docs/automation", (c) => {
  return c.text(AUTOMATION_DOCS, 200, { "content-type": "text/markdown; charset=utf-8" });
});

router.get("/v1/privacy/disclosure", (c) => {
  // Returns the canonical privacy-policy clauses for client / server. Customers'
  // policies link here as the authoritative source so we can update without
  // them having to re-edit their policy.
  const variant = (c.req.query("variant") ?? "server").toLowerCase();
  const includeErrors = (c.req.query("errors") ?? "true") !== "false";
  const includeAnalytics = (c.req.query("analytics") ?? "true") !== "false";

  return c.json({
    canonical_url: "https://agentry.sh/privacy",
    variant: variant === "client" ? "client" : "server",
    last_updated: "2026-05-10",
    includes: {
      errors: includeErrors,
      analytics: includeAnalytics,
    },
    paste_ready_markdown:
      "## Monitoring & analytics\n\n" +
      (includeErrors
        ? (variant === "client"
            ? "### Error monitoring\n\nWe use [agentry](https://agentry.sh) to monitor application errors. When an error occurs in your browser, agentry receives the error type, message, and stack trace; the page URL where it occurred; your browser's user-agent string; and the deploy version that emitted it. We do not intentionally collect personal data through error monitoring."
            : "### Error monitoring\n\nWe use [agentry](https://agentry.sh) to monitor application errors. When an error occurs, agentry receives the error type, message, and stack trace; the URL, environment, and deploy version that emitted it; and any contextual metadata our code attaches.")
        : "") +
      (includeAnalytics
        ? "\n\n" + (variant === "client"
            ? "### Product analytics\n\nWe track aggregate product usage to improve the experience. Tracked events include page views, key product actions, and contextual properties such as the page URL, referrer, language, and user-agent. We assign a randomly-generated identifier stored in your browser's localStorage to keep your interactions consistent across visits."
            : "### Product analytics\n\nWe track aggregate product usage server-side to improve the experience. Tracked events include the action name and contextual properties at the moment of the action.")
        : "") +
      "\n\n*This monitoring is provided by [agentry](https://agentry.sh), an agent-first observability platform.*\n",
    learn_more: "https://agentry.sh",
  });
});

// Client-side JS helper. No `import { agentry } from '@agentry/browser'` —
// agentry has NO SDK by design. Pastes into src/lib/agentry.ts. Uses
// sendBeacon for analytics (survives pagehide), keepalive fetch otherwise.
router.get("/v1/install/sdk/browser", (c) => {
  const code =
    "// src/lib/agentry.ts — client-side, native fetch, no dependencies.\n" +
    "const URL = (import.meta as any).env?.VITE_AGENTRY_URL\n" +
    "         ?? process.env.NEXT_PUBLIC_AGENTRY_URL\n" +
    "         ?? process.env.REACT_APP_AGENTRY_URL!;\n" +
    "const DSN = (import.meta as any).env?.VITE_AGENTRY_DSN\n" +
    "         ?? process.env.NEXT_PUBLIC_AGENTRY_DSN\n" +
    "         ?? process.env.REACT_APP_AGENTRY_DSN!;\n" +
    "const PID = DSN.split('_')[1].split('.')[0];\n" +
    "\n" +
    "type Kind = 'logs' | 'analytics' | 'deploys';\n" +
    "\n" +
    "export function agentry(kind: Kind, payload: object): void {\n" +
    "  const body = JSON.stringify(payload);\n" +
    "  // sendBeacon survives pagehide / navigation. Best for analytics.\n" +
    "  if (kind === 'analytics' && typeof navigator !== 'undefined' && navigator.sendBeacon) {\n" +
    "    navigator.sendBeacon(`${URL}/v1/${kind}/${PID}/`,\n" +
    "      new Blob([body], { type: 'application/json' }));\n" +
    "    return;\n" +
    "  }\n" +
    "  fetch(`${URL}/v1/${kind}/${PID}/`, {\n" +
    "    method: 'POST',\n" +
    "    headers: {\n" +
    "      authorization: `Bearer ${DSN}`,\n" +
    "      'content-type': 'application/json',\n" +
    "      'user-agent': 'agentry-browser/1.0',\n" +
    "    },\n" +
    "    body, keepalive: true,\n" +
    "  }).catch(() => {});\n" +
    "}\n" +
    "\n" +
    "export function getDistinctId(): string {\n" +
    "  let id = localStorage.getItem('agentry_did');\n" +
    "  if (!id) { id = crypto.randomUUID(); localStorage.setItem('agentry_did', id); }\n" +
    "  return id;\n" +
    "}\n" +
    "\n" +
    "export function captureError(err: unknown, extra?: object): void {\n" +
    "  const e = err instanceof Error ? err : new Error(String(err));\n" +
    "  agentry('logs', {\n" +
    "    name: e.name, message: e.message, stack: e.stack,\n" +
    "    user: { id: getDistinctId() },\n" +
    "    tags: { url: location.href, ua: navigator.userAgent }, extra,\n" +
    "  });\n" +
    "}\n" +
    "\n" +
    "export function track(event: string, distinct_id: string,\n" +
    "                     properties: Record<string, unknown> = {}): void {\n" +
    "  agentry('analytics', { event, distinct_id, properties });\n" +
    "}\n" +
    "\n" +
    "// At your app entrypoint, AFTER importing captureError:\n" +
    "window.addEventListener('error', (e) => captureError(e.error ?? e.message, { source: 'window.error' }));\n" +
    "window.addEventListener('unhandledrejection', (e) => captureError(e.reason, { source: 'unhandledrejection' }));\n";

  return c.json({
    language: "browser",
    code,
    required_env: ["NEXT_PUBLIC_AGENTRY_DSN or VITE_AGENTRY_DSN or REACT_APP_AGENTRY_DSN"],
    next_action:
      "Paste into src/lib/agentry.ts. DSN is build-time injected and appears in the bundle " +
      "(public token, ingest-only — safe). For unmangled stack traces, upload your sourcemaps " +
      "via POST /v1/sourcemaps/{project_id}/ after each build — agentry translates minified " +
      "stacks server-side.",
  });
});

export default router;
