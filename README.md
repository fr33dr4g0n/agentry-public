# Agentry for AI Coding Agents

<p>
  <a href="https://agentry.sh">
    <img src="https://agentry.sh/brand/agentry-lockup-light.svg" alt="Agentry" width="248">
  </a>
</p>

Agentry is agent-native analytics and logging for coding agents. It covers
product analytics, error logging, and deploy attribution through one HTTP API so
agents can answer what users did, what broke, and what changed.

## What Agentry Covers

- Product analytics for user, funnel, activation, retention, and business
  events.
- Error logging for exceptions, failed jobs, operational failures, and case
  context.
- Deploy attribution that connects production behavior to releases and code
  changes.
- Agent-led install from the actual codebase, with verification before the
  setup is called complete.

## What This Repository Contains

This repository contains public discovery surfaces for Agentry across MCP,
Claude Code, Codex, and agent IDE adapter ecosystems.

- `packages/mcp` - MCP server that returns the canonical Agentry skill handoff.
- `plugin/agentry` - Claude Code plugin containing the Agentry skill.
- `.claude-plugin/marketplace.json` - Claude Code marketplace catalog.
- `plugins/agentry` - Codex plugin containing the Agentry skill and branding.
- `.agents/plugins/marketplace.json` - Codex plugin marketplace catalog.
- `https://api.agentry.sh/adapters` - live adapter manifest for repo-local
  instruction files used by AI coding IDEs and agent CLIs.

The MCP server and skill do not proxy the Agentry API, ingest telemetry, or
replace the live docs. Runtime apps write directly to Agentry's HTTP API.

## Supported Agent Surfaces

Agentry is distributed as a skill, MCP handoff, OpenAPI Action schema, and
repo-local instruction adapters for the agent surfaces developers already use:

- Codex and Claude Code.
- Cursor, VS Code with GitHub Copilot, Visual Studio with GitHub Copilot, and
  GitHub Copilot coding agent.
- Devin Desktop/Windsurf Cascade, Cline, Roo Code, Continue, Zed, Gemini CLI,
  Aider, and OpenCode.
- ChatGPT custom GPT Actions, generic MCP clients, and AGENTS.md-aware agents.

The adapter manifest is the canonical place to discover the current native
file path for each client: https://api.agentry.sh/adapters.

## Canonical Docs

- Install: https://agentry.sh/install.md
- Skill: https://agentry.sh/skill/agentry/SKILL.md
- Daily use: https://agentry.sh/agentry.md
- API discovery: https://api.agentry.sh/
- OpenAPI: https://api.agentry.sh/v1/openapi.json

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

## Codex Plugin

```bash
codex plugin marketplace add fr33dr4g0n/agentry-public
codex plugin add agentry@agentry
```

The plugin in `plugins/agentry` bundles the same skill for Codex plugin
marketplace installs and includes Agentry logo metadata for Codex plugin cards.
