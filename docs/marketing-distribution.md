# Agentry Distribution Playbook

Agentry's distribution surfaces should stay thin: every listing, plugin, skill,
and MCP wrapper points agents back to the canonical install doc and live HTTP
API. Do not fork install logic into marketplace-specific packages.

Each surface has a different reader:

- Registry and package metadata: short searchable facts.
- MCP tools, prompts, and resources: agent-callable handoff text.
- Skills and repo adapters: operational instructions loaded inside an agent
  session.
- Public README files: human and crawler-facing explanation of what is
  installable and why it exists.
- This playbook: distribution strategy, marketplace copy, and launch tracking.

## Canonical Assets

- Product: https://agentry.sh
- Install: https://agentry.sh/install.md
- Skill: https://agentry.sh/skill/agentry/SKILL.md
- Daily use: https://agentry.sh/agentry.md
- API discovery: https://api.agentry.sh/
- OpenAPI: https://api.agentry.sh/v1/openapi.json
- Adapter manifest: https://api.agentry.sh/adapters
- MCP package path in this repo: `packages/mcp`
- Claude plugin path in this repo: `plugin/agentry`
- Claude marketplace manifest: `.claude-plugin/marketplace.json`

## Positioning

Short description:

> Agentry is agent-native analytics and logging for coding agents: product
> analytics, error logging, and deploy attribution over one HTTP API.

MCP listing description:

> Agent-native analytics, error logging, and deploy attribution for coding
> agents. The MCP server returns canonical install and daily-use handoffs for
> Agentry's live HTTP API.

Claude skill listing description:

> Agentry skill for agent-native analytics, error logging, and deploy
> attribution over the Agentry HTTP API.

Tags:

```text
observability, analytics, error-monitoring, deploys, developer-tools,
coding-agents, mcp, agent-skills
```

## Surface-Specific Copy Rules

1. Package README
   - Lead with what Agentry is.
   - Explain what the package exposes and what it does not do.
   - Put install commands near the top.
   - Mention the canonical install docs before any implementation detail.

2. MCP tool and prompt descriptions
   - Describe the returned handoff and the conditions where the tool applies.
   - Keep side effects explicit: the wrapper returns text only; the agent still
     has to follow the live install or daily-use docs.
   - Include discoverable terms: analytics, logging, error monitoring, product
     telemetry, deploy attribution, production debugging.

3. Skill and adapter docs
   - Use direct operational instructions for an agent in a repo session.
   - Start with the product mental model, then live docs, then auth and write/read
     paths.
   - Do not include marketplace or packaging strategy.

4. Marketplace metadata
   - Keep descriptions short and literal.
   - Avoid claims such as "official", "best", or platform-recommended unless a
     platform grants that status.
   - Prefer nouns users search for: analytics, logging, observability, errors,
     deploys, telemetry, coding agents.

5. Public repo root README
   - Explain that the repo contains the MCP package and plugin/skill.
   - Keep internal submission strategy out of the README.
   - Show install commands and canonical docs.

## Main Places To Post

1. Official MCP Registry
   - Publish `@agentrysh/mcp` to npm.
   - Publish `packages/mcp/server.json` with `mcp-publisher`.
   - The current publishable registry name is
     `io.github.fr33dr4g0n/agentry-observability`. Use DNS authentication later
     if we want to move the official registry name to an `agentry.sh` namespace.

2. Glama
   - Submit the public GitHub repo after the MCP package is public.
   - Category: Observability or Developer Tools.
   - Emphasize that the wrapper is a discovery pointer, not a duplicate API
     surface.

3. Smithery
   - Submit the public repo/package once npm publishing works.
   - Keep the Smithery config equivalent to `npx -y @agentrysh/mcp`.

4. Docker MCP Catalog
   - Add a Docker image only if Docker distribution becomes worth the extra
     artifact.
   - The first pass can stay npm + official registry; Docker prefers curated,
     packaged servers.

5. PulseMCP
   - Check whether the listing appears after the official MCP Registry publish.
   - Submit manually if it does not show up.

6. MCP.so
   - Submit through their GitHub issue flow.
   - Use the same short description and npm install block.

7. MCP Market
   - Submit both the MCP server and the Agent Skill.
   - Paid listing may be worth testing because the audience is already browsing
     MCP servers and skills.

8. mcpservers.org / Awesome MCP Servers
   - Submit the MCP wrapper and, separately, the Agentry skill if their agent
     skills section accepts it.

9. Claude Code plugin marketplace
   - Publish a public repo containing `.claude-plugin/marketplace.json` and
     `plugin/agentry`.
   - User install copy:
     `claude plugin marketplace add <owner>/<repo>` then
     `claude plugin install agentry@agentry`.

10. OpenAI Custom GPT / Actions
    - Create a custom GPT that imports `https://api.agentry.sh/v1/openapi.json`
      as an Action.
    - In the GPT instructions, tell it to start installs from
      `https://agentry.sh/install.md`.

11. Cursor, Windsurf, Codex, AGENTS.md-aware repos
    - These are adapter installs more than marketplaces.
    - Use `https://api.agentry.sh/adapters` as the source of truth and keep
      every generated adapter as a pointer to the same install doc.

## Submission Checklist

1. Make or choose the public repository URL.
2. Publish the MCP npm package:

   ```bash
   cd packages/mcp
   npm publish --access public
   ```

3. Publish to the official MCP Registry:

   ```bash
   cd packages/mcp
   mcp-publisher login github
   mcp-publisher publish server.json
   ```

   Use GitHub auth for `io.github.fr33dr4g0n/agentry-observability`.

4. Submit the same public repo/package to Glama, Smithery, PulseMCP, MCP.so,
   MCP Market, mcpservers.org, and Docker MCP Catalog if a container artifact is
   added.

5. Post the Claude plugin marketplace instructions wherever Claude Code users
   will see them.

6. Track each listing in a lightweight launch sheet:

   ```text
   Marketplace | URL | Submitted | Approved | Notes | Next action
   ```

## Copy Blocks

Directory blurb:

> Agentry is agent-native analytics and logging for coding agents: product
> analytics, error logging, and deploy attribution over one HTTP API. The MCP
> server returns canonical install and daily-use handoffs for the live Agentry
> docs.

First community post:

> I built Agentry for teams using AI coding agents as their daily product/dev
> interface. It gives the agent one API for product events, production errors,
> and deploy history. The agent
> installs telemetry from the repo, verifies real signal, then answers "what
> broke?", "what did users do?", and "what changed?" from live data.
>
> The MCP package is just a discovery wrapper: it points agents to the canonical
> install doc instead of creating another integration surface.
>
> Install doc: https://agentry.sh/install.md

Claude Code post:

> Agentry now has a Claude Code plugin/skill. It teaches Claude to install and
> use Agentry through the live HTTP docs, then verify telemetry before claiming
> success. No SDK, no dashboard-first workflow: the agent uses the API directly.

## Guardrail

If a marketplace asks for extra tools, resist turning the MCP wrapper into an
alternate SDK. Add only signpost resources, prompts, or installer pointers unless
there is a strong reason to expose a new canonical HTTP endpoint in Agentry
itself.
