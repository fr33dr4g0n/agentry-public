# Agentry Distribution Playbook

Agentry's distribution surface should stay thin: every listing, plugin, skill,
and MCP wrapper points agents back to the canonical install doc and live HTTP
API. Do not fork install logic into marketplace-specific packages.

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

> Agentry gives AI coding agents one API for production errors, product events,
> and deploys, so they can debug failures, explain user behavior, and trace
> regressions from real production data.

MCP listing description:

> A tiny MCP discovery wrapper for Agentry. It points agents to the canonical
> Agentry install skill and live HTTP docs; the Agentry HTTP API remains the
> product surface.

Claude skill listing description:

> Teach Claude Code how to install and use Agentry: agent-first error
> monitoring, product analytics, and deploy attribution over one HTTP API.

Tags:

```text
observability, analytics, error-monitoring, deploys, developer-tools,
coding-agents, mcp, agent-skills
```

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

> Agentry gives coding agents production context: errors, product analytics, and
> deploys over one HTTP API. This MCP server is intentionally tiny. It tells the
> agent to install Agentry from the canonical live docs, so every client follows
> the same setup and verification path.

First community post:

> I built Agentry for teams using AI coding agents as their daily product/dev
> interface. It gives the agent one API for production errors, product events,
> and deploy history. The agent installs telemetry from the repo, verifies real
> signal, then answers "what broke?", "what did users do?", and "what changed?"
> from live data.
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
