// Per-request libSQL client. Workers reuse isolates unpredictably,
// so we don't memoize the client globally.

import { createClient } from "@agentry/db";
import type { Env } from "./env.js";

export type AgentryDb = ReturnType<typeof createClient>;

export function getDb(env: Env): AgentryDb {
  return createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
}
