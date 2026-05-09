import type { ApiKey, User } from "@agentry/db/schema";

export interface Env {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  ALLOW_UNVERIFIED_SIGNUP?: string;
  MAX_BODY_BYTES?: string;
  MAX_SUPPRESSIONS_PER_PROJECT?: string;
}

// Hono context variable map.
export interface AppVariables {
  user: User;
  apiKey: ApiKey;
}

export type AppBindings = { Bindings: Env; Variables: AppVariables };
