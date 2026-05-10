import { Hono } from "hono";
import { buildInstallGuide, detectFramework } from "../install-guide.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

const LLMS_TXT = `# agentry

Agent-first incident inbox: errors, analytics, deploys — all routed to the user's
Claude Code session via MCP. The user's own agent investigates and fixes.

## Onboarding (≤ 2 prompts of human input)

1. Add the MCP server to Claude Code:
   claude mcp add agentry -- npx -y @agentry/mcp

2. In Claude Code, say: "set me up with agentry"
   The agent will run the GitHub device flow, mint an api key, provision your
   PostHog project, create an agentry project, fetch the comprehensive install
   guide, and run agentry_verify_install at the end.

## Signal types

agentry is just HTTP. POST any JSON to /v1/log/:project_id/ and we figure out
what kind of signal it is. Or use the typed endpoints if you prefer:

- Universal (auto-detects)                      -> POST /v1/log/:project_id/
- Errors  (Sentry-wire-protocol)                -> POST /v1/store/:project_id/
- Analytics (forwarded to per-user PostHog)     -> POST /v1/track/:project_id/
- Deploys (linked to cases via timestamps)      -> POST /v1/deploys/:project_id/

All four use the same DSN auth (Bearer or X-Sentry-Auth or ?sentry_key=).
The /v1/log/ endpoint detects:
  - 'kind' field if explicitly set
  - has 'exception' / 'stack' / 'name'+'message'+'stack'  → error
  - has 'sha' (and not 'event')                            → deploy
  - has 'event'                                             → analytics
  - everything else                                         → generic log line

## SDKs (optional — agentry is just HTTP)

- @agentry/node      server-side JS (Node 18+, Bun, edge runtimes)
- @agentry/browser   client-side JS (React/Vue/Svelte/vanilla, Next.js client components)

Both expose: agentry.init(), agentry.capture(), agentry.track(), agentry.log(). The Node
SDK also exposes agentry.deploy() (deploys are CI/server-side only).

For other languages, agentry's install guide returns a 30-line copy-paste helper using
the language's stdlib HTTP client — no agentry SDK to install:

  agentry_install_guide(framework: "python")  -> requests.post helper for Python
  agentry_install_guide(framework: "ruby")    -> Net::HTTP helper for Ruby
  agentry_install_guide(framework: "go")      -> net/http helper for Go
  agentry_install_guide(framework: "php" | "java" | "dotnet" | "rust" | "elixir" | "curl")

CORS is enabled on /v1/store/*, /v1/track/*, /v1/deploys/* with Access-Control-Allow-Origin: *
since they're DSN-authenticated. Other endpoints (auth, projects, cases) reject browser
origins; agentry's MCP server is the only intended client there.

## API surface

Auth (no key required):
- POST /v1/auth/device                                          start GitHub device flow
- POST /v1/auth/device/poll        {device_code}                poll until authorized -> {api_key, user_id, github, posthog}

Auth (api-key required, header: Authorization: Bearer <agk_…>):
- POST /v1/auth/keys/rotate                                     mints new key, revokes current
- POST /v1/projects                                             create project -> {id, dsn, install_snippet}
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
      "Read /llms.txt for capabilities. Install the MCP via `claude mcp add agentry -- npx -y @agentry/mcp`.",
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

router.get("/v1/install/sdk/node", (c) => {
  const code =
    "import { agentry } from '@agentry/node';\n" +
    "\n" +
    "agentry.init({\n" +
    "  dsn: process.env.AGENTRY_DSN!,\n" +
    "  deploySha: process.env.GIT_SHA,\n" +
    "  environment: process.env.NODE_ENV,\n" +
    "});\n" +
    "\n" +
    "process.on('uncaughtException', (err) => agentry.capture(err));\n" +
    "process.on('unhandledRejection', (err) => agentry.capture(err as Error));\n";

  return c.json({
    language: "node",
    code,
    required_env: ["AGENTRY_DSN", "GIT_SHA"],
    readme_url: "https://github.com/agentry/agentry#readme",
    next_action:
      "Paste this into your app's entrypoint. Set AGENTRY_DSN to the DSN you got from POST /v1/projects.",
  });
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

router.get("/v1/install/sdk/browser", (c) => {
  const code =
    "import { agentry } from '@agentry/browser';\n" +
    "\n" +
    "agentry.init({\n" +
    "  // Build-time env: NEXT_PUBLIC_AGENTRY_DSN / VITE_AGENTRY_DSN / REACT_APP_AGENTRY_DSN\n" +
    "  dsn: import.meta.env?.VITE_AGENTRY_DSN ?? process.env.NEXT_PUBLIC_AGENTRY_DSN!,\n" +
    "  environment: import.meta.env?.MODE ?? process.env.NODE_ENV,\n" +
    "  // autoCaptureGlobalErrors defaults to true — listens to window 'error' + 'unhandledrejection'.\n" +
    "});\n";

  return c.json({
    language: "browser",
    code,
    required_env: ["NEXT_PUBLIC_AGENTRY_DSN or VITE_AGENTRY_DSN or REACT_APP_AGENTRY_DSN"],
    readme_url: "https://github.com/agentry/agentry#readme",
    next_action:
      "Paste this into your app's client entrypoint, BEFORE other imports. " +
      "DSN is build-time injected — it appears in the final bundle, which is fine: it only grants ingest, never reads.",
  });
});

export default router;
