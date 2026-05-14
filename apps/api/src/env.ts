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
  MAX_SOURCEMAP_BYTES?: string;
  // R2 bucket for browser sourcemaps (uploaded per-release, fetched at case
  // read-time to translate minified stack traces).
  SOURCEMAPS?: R2Bucket;
  // Test backdoor — only enabled in local dev. Production secret store must NOT set this.
  ENABLE_TEST_LOGIN?: string;
  // Admin token gating /admin/* endpoints. If unset, admin routes refuse all
  // requests. Compared against the Authorization: Bearer header via constant-time
  // comparison. Set with `wrangler secret put ADMIN_TOKEN`.
  ADMIN_TOKEN?: string;
}

// Hono context variable map.
export interface AppVariables {
  user: User;
  apiKey: ApiKey;
}

export type AppBindings = { Bindings: Env; Variables: AppVariables };
