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

const LLMS_TXT = `# agentry

Agent-first incident inbox: errors, analytics, deploys — all routed to the user's
Claude Code session via MCP. The user's own agent investigates and fixes.

## Onboarding (≤ 2 prompts of human input)

1. Add the MCP server to Claude Code:
   claude mcp add agentry -- npx -y @agentrysh/mcp

2. In Claude Code, say: "set me up with agentry"
   The agent will run the GitHub device flow, mint an api key, provision your
   PostHog project, create an agentry project, fetch the comprehensive install
   guide, and run agentry_verify_install at the end.

## Signal types

agentry is just HTTP. Three first-party endpoints, one DSN, same JSON convention:

- Logs      -> POST /v1/logs/:project_id/        (any structured event; errors are a subset)
- Analytics -> POST /v1/analytics/:project_id/   (forwarded to per-user PostHog)
- Deploys   -> POST /v1/deploys/:project_id/

All three use the same DSN auth (Bearer or X-Sentry-Auth or ?sentry_key=).
Pick the URL that matches what you're sending. Payloads are open JSON beyond
the few required fields per type. A log with a name/message/stack gets
fingerprinted and grouped into a Case — that's what becomes a "bug" in the
agent's mental model.

### Drop-in aliases for other ecosystems

- POST /v1/store/:project_id/   → Sentry-wire-protocol alias (point Sentry SDKs here)
- POST /v1/track/:project_id/   → PostHog-shaped alias for analytics
- POST /v1/log/:project_id/     → catch-all that auto-detects kind by shape

## No SDK required — agentry is just HTTP

For every supported language, agentry's install guide returns a small copy-paste
helper using the language's stdlib HTTP client:

  agentry_install_guide(framework: "python")  -> requests.post helper for Python
  agentry_install_guide(framework: "ruby")    -> Net::HTTP helper for Ruby
  agentry_install_guide(framework: "go")      -> net/http helper for Go
  agentry_install_guide(framework: "php" | "java" | "dotnet" | "rust" | "elixir" | "curl")

CORS is enabled on /v1/logs/*, /v1/analytics/*, /v1/deploys/* (and the
/v1/store/*, /v1/track/*, /v1/log/* aliases) with Access-Control-Allow-Origin: *
since they're DSN-authenticated. Other endpoints (auth, projects, cases) reject
browser origins; agentry's MCP server is the only intended client there.

## Querying / visualization (no dashboard, agent-driven)

agentry has no UI dashboard. The agent IS the dashboard. Two surfaces:

### Webhooks — for "do X automatically when Y happens"
- POST /v1/projects/:id/webhooks               {url, events?, description?}     -> {id, signing_secret} (shown once)
- GET  /v1/projects/:id/webhooks
- DELETE /v1/projects/:id/webhooks/:id
- POST /v1/projects/:id/webhooks/:id/test      fires a synthetic ping
- GET  /v1/docs/automation                     paste-ready Worker templates for auto-fix-on-error etc.

Events: case.created, case.resolved, deploy.recorded. Body is signed with
HMAC-SHA256; verify via X-Agentry-Signature header.

### Recipes — canned queries for the most-asked questions
- GET /v1/recipes                      list catalog (no auth)
- GET /v1/recipes/:id                  one recipe with full HogQL/SQL template
- POST /v1/projects/:project_id/recipes/:recipe_id/run    {params: {...}}  → rows + render_hint

Recipes cover: DAU/cohorts/retention, 3-step funnels with drop-offs, top events,
event time-series, conversion rates, top open errors, errors-per-hour, errors after
last deploy, deploy frequency.

### Ad-hoc queries — when no recipe matches
- POST /v1/projects/:project_id/analytics/query  {query: "<HogQL>"}
- GET  /v1/docs/query   markdown schema + HogQL primer for the agent to consume

The agent's loop: user asks "show me retention" → agent calls list_recipes → finds
weekly_retention → calls run_recipe → renders the rows as a markdown table or
ASCII chart. Anything quirky → agent composes HogQL from the schema doc.

## API surface

Auth (no key required):
- POST /v1/auth/device                                          start GitHub device flow
- POST /v1/auth/device/poll        {device_code}                poll until authorized -> {api_key, user_id, github, posthog}

Auth (api-key required, header: Authorization: Bearer <agk_…>):
- POST /v1/auth/keys/rotate                                     mints new key, revokes current
- POST /v1/projects                                             create project -> {id, dsn, logs_url, analytics_url, deploys_url, install_snippet}
- GET  /v1/projects
- GET  /v1/projects/:id
- GET  /v1/projects/:id/cases?status=open
- GET  /v1/cases/:id                                            case detail (incl. recent_deploys)
- PATCH /v1/cases/:id
- POST /v1/cases/:id/runs
- POST /v1/projects/:id/suppressions
- GET  /v1/projects/:id/suppressions
- GET  /v1/projects/:id/deploys?limit=20&since=<unixSeconds>
- POST /v1/projects/:id/analytics/query  {query: "<HogQL>"}     PostHog passthrough

Discovery (no auth):
- GET  /                       service metadata
- GET  /llms.txt               this file
- GET  /v1/install/guide?framework=node|next|express   comprehensive setup checklist
- GET  /v1/install/sdk/node    minimal init snippet

## Privacy disclosure

- GET /v1/privacy/disclosure?variant=client|server&errors=true&analytics=true
  Returns paste-ready privacy-policy clauses for the agent to merge into the customer's
  privacy policy. agentry.sh is the canonical link; customers' policies pointing here
  also serve as honest backlinks.

## Errors

Every error response: {"error": {"code": "...", "message": "...", "next_action": "..."}}.
Codes include: invalid_payload, unauthorized, invalid_api_key, invalid_dsn, not_found,
forbidden, rate_limited, payload_too_large, posthog_capture_failed, analytics_not_configured.
`;

router.get("/", (c) => {
  return c.json({
    name: "agentry",
    version: "0.0.0",
    docs: "/llms.txt",
    next_action:
      "Read /llms.txt for capabilities. Install the MCP via `claude mcp add agentry -- npx -y @agentrysh/mcp`.",
  });
});

router.get("/llms.txt", (c) => {
  return c.text(LLMS_TXT, 200, { "content-type": "text/plain; charset=utf-8" });
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
