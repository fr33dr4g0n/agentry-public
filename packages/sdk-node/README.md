# @agentry/node

Node SDK for [Agentry](https://agentry.dev) — agent-first error monitoring.

## Install

```bash
npm install @agentry/node
```

Requires Node 18+.

## Usage

```ts
import { agentry } from "@agentry/node";

agentry.init({
  dsn: process.env.AGENTRY_DSN!,
  environment: process.env.NODE_ENV,
  deploySha: process.env.GIT_COMMIT,
});

process.on("uncaughtException", agentry.captureUncaught);
process.on("unhandledRejection", agentry.captureUncaught);
```

Anywhere you catch an error:

```ts
agentry.capture(err, { tags: { route: "/checkout" }, user: { id: userId } });
```

Get a DSN by running the `agentry_create_project` MCP tool against your local
Agentry server.

## API

- `agentry.init({ dsn, deploySha?, environment?, release?, serverUrl? })`
- `agentry.capture(err, { tags?, extra?, user? })`
- `await agentry.flush(timeoutMs = 2000)` — drain the queue, returns `false` on timeout
- `await agentry.close()` — flush and detach
