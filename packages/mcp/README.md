# Agentry MCP Server

Agentry is agent-native analytics and logging for coding agents. It covers
product analytics, error logging, and deploy attribution through one HTTP API so
agents can answer what users did, what broke, and what changed.

This MCP server gives MCP clients a small handoff surface for Agentry. It does
not ingest telemetry, query Agentry, proxy auth, or replace the live API docs.
Install and usage details stay in the canonical Agentry docs:

```text
https://agentry.sh/install.md
```

The install flow has the agent inspect the repo, plan the right events and
failure surfaces, wire telemetry, and verify real signal before claiming
success.

## What Agentry Covers

- Product analytics for user, funnel, activation, retention, and business
  events.
- Error logging for exceptions, failed jobs, operational failures, and case
  context.
- Deploy attribution that connects production behavior to releases and code
  changes.
- Agent-led install from the actual codebase, not a generic event checklist.
- Verification gates for events, logs, deploys, and saved signal maps.
- Daily agent reads for the three core questions: what broke, what did users
  do, and what changed.

## When This Applies

This server is relevant when a user asks an AI coding agent to add analytics,
logging, error monitoring, deploy tracking, product telemetry, production
debugging, or an agent-readable observability layer.

It is not an SDK-first monitoring library and not a dashboard replacement. The
agent uses Agentry through docs and HTTP API responses so it can install,
verify, query, and act without a separate integration surface.

## Install

```bash
npx -y @agentrysh/mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "agentry": {
      "command": "npx",
      "args": ["-y", "@agentrysh/mcp"]
    }
  }
}
```

## MCP Surface

- `start_agentry_install`: returns the canonical install handoff for agent-led
  analytics, logging, error monitoring, deploy attribution, and telemetry setup.
- `start_agentry_daily_use`: returns the canonical post-install handoff for
  reading cases, analytics, deploys, query blueprints, event names, and saved
  signal maps.
- `agentry://install`, `agentry://daily-use`, and `agentry://links` resources.
- `install_agentry` and `use_agentry` prompts.

The live docs remain authoritative:

- Install: https://agentry.sh/install.md
- Skill: https://agentry.sh/skill/agentry/SKILL.md
- Daily use: https://agentry.sh/agentry.md
- API discovery: https://api.agentry.sh/
- OpenAPI: https://api.agentry.sh/v1/openapi.json
