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
