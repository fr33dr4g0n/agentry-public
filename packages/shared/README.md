# @agentrysh/shared

Shared types, error envelopes, DSN parsing and fingerprinting utilities used by [agentry](https://agentry.sh).

Most users don't need to install this directly — it's a transitive dependency of [`@agentrysh/mcp`](https://www.npmjs.com/package/@agentrysh/mcp). Pull it in if you're building a custom agentry integration and want the same primitives.

## Exports

- `parseDsn(dsn)` — parse an `agnt_<projectId>.<token>` DSN
- `computeFingerprint({ errorType, message, frames })` — agentry's error-grouping hash
- `IngestEventSchema`, `IngestEventPayload` — zod schema for the typed error endpoint
- `AgentryError`, `errors` — typed error envelope used across the API
- `uuidv7`, `sha256Hex` — small id/crypto helpers
- Type-only exports: `AgentryConfig`, `CaseDetail`, `CaseSummary`, `StackFrame`, etc.

## Install

```bash
npm install @agentrysh/shared
```

## License

MIT
