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

- Errors  (Sentry-wire-protocol ingest)         -> POST /v1/store/:project_id/
- Analytics (forwarded to per-user PostHog)     -> POST /v1/track/:project_id/
- Deploys (linked to cases via timestamps)      -> POST /v1/deploys/:project_id/

All three use the same DSN auth (Bearer or X-Sentry-Auth or ?sentry_key=).

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

export default router;
