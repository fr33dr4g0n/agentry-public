// Per-request libSQL client. Cloudflare Workers reuse isolates unpredictably,
// so we don't memoize the client globally.
//
// The `@libsql/client/web` entry point is required when running on Workers
// (it skips Node-only deps like libsql native bindings).

import { createClient as createLibsql } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

export type AgentryDb = ReturnType<typeof drizzle<typeof schema>>;

export function createClient(opts: { url: string; authToken?: string }): AgentryDb {
  const client = createLibsql({ url: opts.url, authToken: opts.authToken });
  return drizzle(client, { schema });
}
