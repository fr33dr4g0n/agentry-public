import type { ApiKey, User } from "@agentry/db/schema";

export interface Env {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  // PostHog analytics — shared-project + groups model. agentry sends every
  // user's events into ONE PostHog project, tagged with `$groups.agentry_user
  // = <userId>` so HogQL queries filter per user. See apps/api/src/posthog.ts.
  POSTHOG_HOST?: string;            // e.g. https://posthog.agentry.sh
  POSTHOG_PROJECT_ID?: string;      // shared project id (e.g. "1" — PostHog's Default project)
  POSTHOG_PROJECT_API_KEY?: string; // shared project write key (phc_…) for /capture/
  POSTHOG_MASTER_API_KEY?: string;  // org-admin Personal API key (phx_…) for HogQL queries
  POSTHOG_ORG_ID?: string;          // legacy — kept for createPosthogProject back-compat
  AGENTRY_TOKEN_ENC_KEY?: string;   // 32-byte base64url AES-256 key (used by webhooks.ts)
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
