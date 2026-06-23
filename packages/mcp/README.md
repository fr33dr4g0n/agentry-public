# Agentry MCP Server

<p>
  <a href="https://agentry.sh">
    <img src="https://agentry.sh/brand/agentry-lockup-light.svg" alt="Agentry" width="248">
  </a>
</p>

Agentry gives AI coding agents product analytics, error logging, and deploy
attribution through one HTTP API so agents can answer what users did, what
broke, and what changed.

## What Agentry Does

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

## What This MCP Server Does

This server gives MCP clients one Agentry handoff:

- It points agents to the canonical Agentry skill.
- It keeps setup and daily-use routing inside that skill.
- It does not ingest telemetry, query Agentry, proxy auth, or replace the live
  API reference.

## Public Links

- Website: https://agentry.sh/
- NPM package: https://www.npmjs.com/package/@agentrysh/mcp
- MCP repository: https://github.com/fr33dr4g0n/agentry-public
- Skill repository: https://github.com/fr33dr4g0n/agentry-skill
- Live skill: https://agentry.sh/skill/agentry/SKILL.md
- Adapter manifest: https://api.agentry.sh/adapters
- Codex marketplace catalog: https://github.com/fr33dr4g0n/agentry-public/blob/main/.agents/plugins/marketplace.json
- Claude marketplace catalog: https://github.com/fr33dr4g0n/agentry-public/blob/main/.claude-plugin/marketplace.json
- MCP registry name: `io.github.fr33dr4g0n/agentry-observability`

## When This Applies

This server is relevant when a user asks an AI coding agent to add analytics,
logging, error monitoring, deploy tracking, product telemetry, production
debugging, or an agent-readable observability layer.

It is not an SDK-first monitoring library and not a dashboard replacement. The
agent uses Agentry through docs and HTTP API responses so it can install,
verify, query, and act without a separate integration surface.

## MCP Surface

- `get_agentry_skill`: returns the canonical Agentry skill handoff.
- `agentry://skill`: the same skill handoff as a resource.
- `agentry://links`: canonical Agentry links as JSON.
- `use_agentry_skill`: prompt that tells the agent to load or install the skill.

## Install The MCP Server

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

After the MCP server is available, an agent should call `get_agentry_skill`
when the user asks for Agentry, analytics, logging, error monitoring, product
telemetry, deploy attribution, or production debugging. The returned skill
handoff tells the agent where to load the canonical Agentry skill.

The live docs remain authoritative:

- Install: https://agentry.sh/install.md
- Skill: https://agentry.sh/skill/agentry/SKILL.md
- Daily use: https://agentry.sh/agentry.md
- API discovery: https://api.agentry.sh/
- OpenAPI: https://api.agentry.sh/v1/openapi.json
