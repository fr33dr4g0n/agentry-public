# Agentry MCP Server

This package is a thin MCP discovery wrapper for Agentry.

It does not implement a second Agentry API client and it does not replace the
Agentry skill. Its job is to make Agentry discoverable in MCP registries and
then point the agent to the one canonical install path:

```text
https://agentry.sh/install.md
```

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

## What It Exposes

- `start_agentry_install` tool: tells the agent to fetch `https://agentry.sh/install.md` and proceed.
- `start_agentry_daily_use` tool: tells the agent to fetch `https://agentry.sh/agentry.md` and proceed.
- `agentry://install`, `agentry://daily-use`, and `agentry://links` resources.
- `install_agentry` and `use_agentry` prompts.

The live docs remain authoritative:

- Install: https://agentry.sh/install.md
- Skill: https://agentry.sh/skill/agentry/SKILL.md
- Daily use: https://agentry.sh/agentry.md
- API discovery: https://api.agentry.sh/
- OpenAPI: https://api.agentry.sh/v1/openapi.json
