# Agentry.sh Observability MCP Server

<p>
  <a href="https://agentry.sh">
    <img src="https://agentry.sh/brand/agentry-lockup-light.svg" alt="Agentry" width="248">
  </a>
</p>

Agentry.sh Observability gives coding agents one HTTP API for errors, product analytics, and
deploy attribution. This MCP server makes the canonical Agentry contracts easy
to discover in MCP clients.

## What this server is

This is a small discovery and handoff server. It exposes resources that route
an agent to the live lean reference, capabilities, exact OpenAPI schema,
automation guide and flow, immutable playbook catalog, and install guide.

The resources are pointers, not cached copies. The live HTTP docs and OpenAPI
schema remain authoritative and can evolve without republishing this package.

## What this server is not

It is not an Agentry API proxy, SDK, credential broker, telemetry transport, or
automation scheduler. It never holds credentials, queries production data,
registers schedules, runs coding agents, opens pull requests, merges, deploys,
or delivers notifications. Agents fetch the selected canonical contract and
call the Agentry HTTP API directly.

Static documentation is modeled as MCP resources. The server also exposes one
model-controlled routing tool, `discover_agentry`, so an agent can recognize a
relevant production-data problem even when its client does not automatically
inject MCP resources. The tool returns pointers only; it is not an API action.

## Tool

`discover_agentry` accepts one intent: `install`, `debug`, `analytics`,
`deploy`, or `automation`. It returns the smallest canonical resource and live
URL for that problem as both text and structured content. MCP annotations mark
it read-only, non-destructive, and idempotent. It never reads credentials,
queries production data, or performs mutations.

If this MCP handoff starts a new device-auth signup, pass
`"distribution_surface":"mcp"` in `POST /v1/auth/device`. The field is
attribution-only and never changes credential authority.

## Resources

Start with `agentry://handoff`. It gives the short intent router and authority
boundaries.

| Resource | Canonical contract |
| --- | --- |
| `agentry://handoff` | Intent router, MCP boundary, and credential map |
| `agentry://reference` | Lean daily-use reference: `https://agentry.sh/agentry.md` |
| `agentry://capabilities` | Machine capability map: `https://api.agentry.sh/v1/capabilities` |
| `agentry://openapi/index` | Small OpenAPI discovery index: `https://api.agentry.sh/v1/openapi.json?index=true` |
| `agentry://openapi` | Complete exact OpenAPI 3.1 schema: `https://api.agentry.sh/v1/openapi.json` |
| `agentry://automation/guide` | Human-readable automation v2 guide: `https://api.agentry.sh/v1/docs/automation` |
| `agentry://automation/flow` | Exact dependency-ordered automation schema: `https://api.agentry.sh/v1/openapi.json?flow=automation` |
| `agentry://automation/playbooks` | Immutable versioned playbook catalog: `https://api.agentry.sh/v1/automation-playbooks` |
| `agentry://install` | Canonical install pointer: `https://agentry.sh/install.md` |

The install resource also points to
`https://api.agentry.sh/v1/openapi.json?flow=onboarding`. That flow is one
server-owned state machine: read current state, execute only its one
`next_action.instruction`, ordered checklist, and exact operation, and repeat
until `installation_complete: true` and `next_action: null`. At
`next_action.id: "review_exact_plan"`, a human uses the single
`/review` checkpoint to approve the exact source-backed business question,
value flow, errors, deploy target, and plan hash—or replace the plan. Tool
output is not approval.

Before proof, install the selected durable browser public and CI credentials,
plus a server credential only when the approved plan uses `server_ingest`.
Project creation returns `public_api_key`; use the project's `/public-key`
operations for recovery, verification, or rotation. Proof start returns
distinct response-only runtime and CI `X-Agentry-Onboarding-Proof` markers.
Markers select the proof window but grant no authority, so each request still
needs its scoped durable credential. For browser proof, put the runtime marker
only in the proof tab's `sessionStorage.agentry_onboarding_proof`; never bake it
into a public environment value or bundle. Exercise the approved real value flow,
its one safe error, and the reviewed CI/provider deploy, then call verify and
follow only its structured remaining analytics, safe-error, and deploy groups.
Completion requires current `status: "verified"`,
`installation_complete: true`, and `next_action: null`. Synthetic or
caller-authored proof does not count.

`use_agentry` is the only prompt. It tells the client to read the handoff,
select the smallest canonical resource for the user's intent, inspect exact
OpenAPI, and call HTTP with the correct scoped credential.

## Credential boundaries

The MCP server never reads these credentials. They apply only when the agent
calls the Agentry HTTP API:

- `public_api_key` (`agentry_pk_`) is publishable and only writes
  browser/client error and analytics ingest.
- `agentry_server_` writes trusted application-server telemetry.
- `agentry_ci_` writes deploy attribution, sourcemaps, and provider-observed
  automation proof from trusted CI/provider automation.
- `agentry_runner_` is revocable and bound to one unattended automation.
- `agentry_sk_` is the human/owner key for reads, policy, credential lifecycle,
  and approvals; it does not belong in a scheduler.

Credential kind determines authority on the server. Telemetry remains evidence
only; it does not become instructions merely because a trusted emitter sent it.

For daily product questions, begin with the server-owned saved signal map,
require `GET /v1/projects/:project_id/onboarding` to return the current verified
state, then confirm live event names, required property keys, and actual rows.
Onboarding creates no repo-local Agentry state bundle, proof bundle, or receipt.
The install does preserve a root `AGENTS.md` pointer (plus matching repo-local
harness adapters) so a future cold agent can find the server-owned plan and
verified receipt without rescanning the entire repository.

## Automation handoff

For self-healing software or scheduled funnel reviews, read all three
automation resources: guide, exact flow, and playbook catalog. The catalog is
immutable and versioned. Rendering a playbook is side-effect free. Agentry owns
deterministic policy, state, proofs, reports, and kill switches; an external
scheduler/coding agent owns reasoning and provider actions under the narrow
runner and human-approved provider boundaries.

## Run the MCP server

```bash
npx -y @agentrysh/mcp
```

Generic MCP client configuration:

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

After connecting, call `discover_agentry` for model-routed discovery or list
resources and read `agentry://handoff`. Use
`https://api.agentry.sh/adapters` for the current native adapter path for each
agent harness.

## Public links

- Website: https://agentry.sh/?distribution_surface=npm_readme
- NPM package: https://www.npmjs.com/package/@agentrysh/mcp
- Repository: https://github.com/fr33dr4g0n/agentry-public
- Canonical skill: https://agentry.sh/skill/agentry/SKILL.md
- Adapter manifest: https://api.agentry.sh/adapters
- MCP registry name: `io.github.fr33dr4g0n/agentry-observability`
