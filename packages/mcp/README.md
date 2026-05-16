# @agentrysh/mcp

The canonical agentry entry point. Drop it into Claude Code, Cursor or any MCP-compatible AI and your assistant can read your app's errors, analytics and deploys directly — no dashboard, no docs, no query language to learn.

## Install (Claude Code)

```bash
claude mcp add agentry -- npx -y @agentrysh/mcp
```

Then in your session:

> set me up with agentry

The agent will walk you through the GitHub device-flow login, mint an API key, create an agentry project, and hand you a paste-ready snippet for your app.

## What you get

Once installed, your AI assistant can:

- **Read errors** — `agentry_list_cases`, `agentry_get_case` (with stack, breadcrumbs, deploy attribution)
- **Run named queries** — `agentry_run_recipe` (14 canonical queries: DAU, funnels, retention, top errors, deploy health, weekly digest)
- **Ask anything in HogQL** — `agentry_analytics_query`
- **Send events** — `agentry_capture_test_event`, `agentry_record_deploy`, `agentry_track_test_event`
- **Manage suppressions, webhooks, alerts** — full CRUD on the QoL layer

## What agentry is

A small, agent-first observability backend. Three HTTP endpoints, one DSN:

- `POST /v1/logs/{project_id}/`
- `POST /v1/analytics/{project_id}/`
- `POST /v1/deploys/{project_id}/`

Send JSON. Your AI does the rest.

See [agentry.sh](https://agentry.sh) for the full pitch.

## License

MIT
