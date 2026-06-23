# Agentry Public Artifacts

Agentry gives AI coding agents one HTTP API for production errors, product
analytics events, and deploy attribution.

This public repo exists for reviewable distribution artifacts:

- `packages/mcp` - a tiny MCP discovery wrapper. It points agents to the
  canonical Agentry install docs instead of reimplementing Agentry as an MCP
  client.
- `plugin/agentry` - the Agentry Claude Code plugin/skill. It teaches future
  sessions to fetch the live Agentry docs and use the HTTP API directly.
- `.claude-plugin/marketplace.json` - Claude plugin marketplace metadata.

The live docs are the source of truth:

- Install: https://agentry.sh/install.md
- Skill: https://agentry.sh/skill/agentry/SKILL.md
- Daily use: https://agentry.sh/agentry.md
- API discovery: https://api.agentry.sh/
- OpenAPI: https://api.agentry.sh/v1/openapi.json

## MCP

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

## Claude Code Skill

```bash
mkdir -p ~/.claude/skills/agentry
curl -fsSL https://agentry.sh/skill/agentry/SKILL.md > ~/.claude/skills/agentry/SKILL.md
```

The plugin version in `plugin/agentry` bundles the same skill for Claude plugin
marketplace installs.
