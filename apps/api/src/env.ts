import type { ApiKey, User } from "@agentry/db/schema";

export interface Env {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  // PostHog multi-tenant analytics (optional in v0; if unset, /v1/track 503s)
  POSTHOG_HOST?: string;            // e.g. https://posthog.agentry.sh
  POSTHOG_ORG_ID?: string;          // The agentry-managed org id in PostHog
  POSTHOG_MASTER_API_KEY?: string;  // Personal API key with org-admin scope
  AGENTRY_TOKEN_ENC_KEY?: string;   // 32-byte base64url AES-256 key for PostHog read tokens
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
