import { Hono } from "hono";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

const LLMS_TXT = `# agentry

Agent-first error monitoring. The user's own Claude Code investigates errors via MCP.

## What this is

agentry receives error events from your apps via SDKs (Sentry-protocol-compatible),
stores them, and serves them to your Claude Code session over MCP. Every response is
shaped for an agent: machine-readable error codes, next_action hints, and structured
case detail with stack traces, deploy SHA, and suppression hints.

## Onboarding (≤ 2 prompts of human input)

1. Add the MCP server to Claude Code:
   claude mcp add agentry -- npx -y @agentry/mcp

2. In Claude Code, say: "set me up with agentry, my email is you@example.com"
   The agent will sign you up, mint an api key, create a project, and give you the
   exact code to paste in your app.

## API endpoints

- POST /v1/auth/signup           {email}                              -> {api_key, user_id, prefix, next_action}
- POST /v1/auth/keys/rotate      Authorization: Bearer <key>          -> new key, revokes old
- POST /v1/projects              {name, repo_url?, default_branch?}    -> {id, dsn, install_snippet}
- GET  /v1/projects                                                   -> list (no DSNs — only shown at creation)
- GET  /v1/projects/:id                                               -> detail
- GET  /v1/projects/:id/cases?status=open                             -> case list
- GET  /v1/cases/:id                                                  -> case detail with recent_events + next_actions
- PATCH /v1/cases/:id            {status?, agent_summary?, pr_url?}    -> updated case
- POST /v1/cases/:id/runs        {status, summary_md?, pr_url?}        -> recorded agent run
- POST /v1/projects/:id/suppressions   {fingerprint_pattern, action, reason?, hint_text?}
- GET  /v1/projects/:id/suppressions
- POST /v1/store/:project_id/    Sentry-wire-protocol ingest. Auth via Bearer DSN, X-Sentry-Auth, or ?sentry_key=
- GET  /v1/install/sdk/node                                           -> {language, code, required_env}

## Ingest format

The /v1/store/:project_id/ endpoint accepts the Sentry envelope shape. Minimum:
- exception.values[0].type, value
- exception.values[0].stacktrace.frames[]
- release (mapped to deploy_sha if deploy_sha not set)
- environment

The server fingerprints by sha1(error_type + ":" + frame0.fn + ":" + frame0.file + ":" + frame0.lineno).

## Errors

Every error response: {"error": {"code": "...", "message": "...", "next_action": "..."}}.
HTTP status mirrors HTTP semantics. Codes include: invalid_payload, unauthorized,
invalid_api_key, invalid_dsn, not_found, forbidden, rate_limited, signup_disabled.

## v0 caveats

- No email verification. Same email twice mints a new key (existing keys remain valid).
- Hard-gated behind ALLOW_UNVERIFIED_SIGNUP env var. Not for public deploy.
- No web UI. Everything is API + MCP.
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
