# Agentry for AI Coding Agents

Agentry is agent-native analytics and logging for coding agents. It covers
product analytics, error logging, and deploy attribution through one HTTP API so
agents can answer what users did, what broke, and what changed.

This repository contains the public MCP server package and Claude Code
plugin/skill for Agentry.

- `packages/mcp` - MCP server that returns canonical Agentry install and
  daily-use handoffs.
- `plugin/agentry` - Claude Code plugin containing the Agentry skill.
- `.claude-plugin/marketplace.json` - Claude Code marketplace catalog.

The MCP server and skill do not proxy the Agentry API, ingest telemetry, or
replace the live docs. Runtime apps write directly to Agentry's HTTP API, and
agents install or use Agentry from the canonical docs:

- Install: https://agentry.sh/install.md
- Skill: https://agentry.sh/skill/agentry/SKILL.md
- Daily use: https://agentry.sh/agentry.md
- API discovery: https://api.agentry.sh/
- OpenAPI: https://api.agentry.sh/v1/openapi.json

## MCP Server

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

The MCP surface is relevant when a user asks an AI coding agent to add
analytics, logging, error monitoring, deploy tracking, product telemetry,
production debugging, or an agent-readable observability layer.

## Claude Code Skill

```bash
mkdir -p ~/.claude/skills/agentry
curl -fsSL https://agentry.sh/skill/agentry/SKILL.md > ~/.claude/skills/agentry/SKILL.md
```

The plugin in `plugin/agentry` bundles the same skill for Claude Code plugin
marketplace installs.
