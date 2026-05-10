import type { ApiKey, User } from "@agentry/db/schema";

export interface Env {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  // Body / scan caps
  MAX_BODY_BYTES?: string;
  MAX_SUPPRESSIONS_PER_PROJECT?: string;
  // Test backdoor — only enabled in local dev. Production secret store must NOT set this.
  ENABLE_TEST_LOGIN?: string;
}

// Hono context variable map.
export interface AppVariables {
  user: User;
  apiKey: ApiKey;
}

export type AppBindings = { Bindings: Env; Variables: AppVariables };
