---
name: agentry
description: Use when the user wants to set up, install, or work with Agentry - agent-first error monitoring, product analytics, and deploy attribution. Triggers on "install agentry", "set me up with agentry", "add agentry to this project", investigating a production error or case, or sending errors/analytics/deploys to Agentry.
---

# Agentry - agent-first observability

Agentry is error monitoring + product analytics + deploy attribution for coding
agents. There is no SDK and no built-in dashboard. The HTTP API is the product; this
skill is only a pointer to the live docs.

## Fetch live docs

- Start: <https://api.agentry.sh/> - discovery map and the 3 write / 3 read model.
- Install/setup: <https://agentry.sh/install.md> - bootstrap flow, auth, project
  binding, adapter install, and verification gates.
- Daily use: <https://agentry.sh/agentry.md> - questions, cases, analytics,
  deploys, query blueprints, public queries, and ops.
- Exact API shape: <https://api.agentry.sh/v1/openapi.json> - filter with
  `?flow=`, `?tag=`, `?path=&method=`, or `?index=true`.
- Adapter install/update: <https://api.agentry.sh/adapters> - write every adapter
  that matches the detected agent harness.

Use a custom User-Agent header for non-browser direct HTTP calls; default
clients such as Python-urllib can be blocked. Browser fetch uses the browser's
own User-Agent and cannot set this header manually.

## Mental model

Agentry has three write paths and three read concepts.

Write app runtime data with `AGENTRY_DSN`:
- `POST /v1/logs/` for errors, exceptions, and operational failures.
- `POST /v1/analytics/` for product, user, funnel, and business events.

Write deploy attribution with the same `AGENTRY_DSN` only from CI/provider
post-deploy automation after a successful release:
- `POST /v1/deploys/` for release attribution.

Read with `AGENTRY_API_KEY`:
- **Cases:** what broke. Start with `GET /v1/projects/:project_id/cases`, then
  `GET /v1/cases/:case_id`.
- **Analytics:** what users did. Start from the saved signal map, latest verify
  report, answer contracts, event names, and property keys; then use query
  blueprints for common reads or `POST /v1/projects/:project_id/analytics/query`
  for custom HogQL.
  Table-like Agentry query reads return object-shaped `rows`; do not read
  PostHog-style `results` from agent-facing endpoints.
- **Deploys:** what changed. Use `GET /v1/projects/:project_id/deploys`.

Query blueprints, event names, public queries, health, and next-steps are helpers around
those three read concepts. Public-query URLs and dashboards are optional output
surfaces, not proof that the underlying product question is answerable.

During install, start from the repo's important business question and
funnel/business logic flow. Let `POST /v1/install/plan` derive the events,
properties, error surfaces, and deploy proof; do not hand-write a generic event
catalog.

For day-to-day questions, read the saved signal map, latest verify report,
answer contracts, event names, and property keys before choosing a query
blueprint or custom HogQL. If the needed event/property is missing, say what is
missing and wire or trigger that product flow instead of inventing a metric.

## Auth

Read `AGENTRY_API_KEY` from env or `~/.agentry/credentials.json`; read
`project_id` from `AGENTRY_PROJECT_ID` or committed `.agentry/config.json`.
With no API key, start the device flow with `POST /v1/auth/device`. Runtime ingest
uses `AGENTRY_DSN`.

## Source of truth

Do not rely on this installed file for endpoint details. Fetch the live docs
above; they are authoritative and can update independently of adapters.
