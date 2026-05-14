# Agentry — Repo Instructions for Claude

## What this is
Agent-first error monitoring. The user's own Claude Code (running this MCP server) investigates errors. We never run LLM calls server-side.

## Read order for new sessions
1. [PLAN.md](./PLAN.md) — the contract. What we're building and why.
2. [STATUS.md](./STATUS.md) — where the build got to.
3. `docs/decisions.md` — append-only log of decisions and rationale.

## Hard rules
- **AGENTS FIRST.** No interface that requires a human to open a browser. MCP is canonical.
- **Never run an LLM server-side** in the API or worker. The agent runs in the user's Claude Code.
- **No opaque server-side compute.** The HTTP API is the data plane only — storage, retrieval, and deterministic queries. Any transformation the user might want to audit (stack unmangling, fingerprinting, formatting, anything that "translates" data) lives in the MCP package, where the code is on npm and reviewable in `node_modules/@agentrysh/mcp/dist/`. The principle:
  - If it's **storage / retrieval / a query** → HTTP API endpoint, then a 1:1 MCP tool that wraps it (parity).
  - If it's a **transformation that benefits from being review-able** → MCP-only local compute, no HTTP equivalent. Adding it to the API re-introduces server-side magic.
- **Update STATUS.md** at the end of every meaningful sub-task.
- **Append to docs/decisions.md** when you make a non-trivial choice.

## Stack
TypeScript, Cloudflare Workers (Hono), Turso/libSQL via Drizzle, Zod, Vitest, npm workspaces. MCP via `@modelcontextprotocol/sdk`.

## Commands
- `npm install` at root
- `npm run typecheck` — across all packages
- `npm run test` — vitest across all
- `npm run dev` (in apps/api) — wrangler dev
- `npm run deploy` (in apps/api) — wrangler deploy

## Pitfalls
- Workers don't have `Buffer` or many Node APIs by default. Use Web Crypto, not `crypto`.
- Drizzle migrations in libSQL: use `drizzle-kit push` for v0 (no separate migrations folder).
- `@modelcontextprotocol/sdk` stdio server requires Node, not Workers — MCP runs client-side.
