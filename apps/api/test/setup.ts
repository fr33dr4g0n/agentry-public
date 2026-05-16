// Test bootstrap — builds an in-memory libsql DB and stubs the api's getDb()
// to return it for the lifetime of one test.

import { createClient as createLibsql, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentry/db/schema";

export interface TestEnv {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ENABLE_TEST_LOGIN: string;
  // Optional — webhook signing-secret encryption uses AES-256-GCM with this key.
  // Required for webhook CRUD tests but unused for plain ingest.
  AGENTRY_TOKEN_ENC_KEY?: string;
}

// 32-byte all-zeros key, base64url-encoded (no pad). Deterministic for tests.
// AES-256-GCM requires a 32-byte key; the value doesn't have to be secret in tests.
export const TEST_ENC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Cache so getDb() returns the same connection within one test.
const dbByUrl = new Map<
  string,
  { client: Client; drizzle: ReturnType<typeof drizzle<typeof schema>> }
>();

export async function makeTestEnv(opts?: {
  enableTestLogin?: boolean;
  withEncKey?: boolean;
}): Promise<TestEnv> {
  const url = `:memory:#${Math.random().toString(36).slice(2)}`;
  const client = createLibsql({ url: ":memory:" });
  const d = drizzle(client, { schema });

  // Apply schema. Mirrors packages/db/src/schema.ts.
  await client.batch(
    [
      `CREATE TABLE users (
        id text PRIMARY KEY,
        github_id integer NOT NULL,
        github_username text NOT NULL,
        email text,
        avatar_url text,
        plan text NOT NULL DEFAULT 'free',
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX users_github_id_idx ON users (github_id)`,
      `CREATE INDEX users_email_idx ON users (email)`,
      `CREATE TABLE api_keys (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind text NOT NULL DEFAULT 'private',
        prefix text NOT NULL,
        key_hash text NOT NULL,
        name text,
        last_used_at integer,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        revoked_at integer
      )`,
      `CREATE UNIQUE INDEX api_keys_hash_idx ON api_keys (key_hash)`,
      `CREATE INDEX api_keys_user_idx ON api_keys (user_id)`,
      `CREATE INDEX api_keys_user_kind_idx ON api_keys (user_id, kind)`,
      `CREATE TABLE public_query_publications (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id text NOT NULL,
        recipe_id text NOT NULL,
        params_json text NOT NULL DEFAULT '{}',
        description text,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        last_used_at integer,
        revoked_at integer
      )`,
      `CREATE INDEX pubq_user_idx ON public_query_publications (user_id)`,
      `CREATE INDEX pubq_project_idx ON public_query_publications (project_id)`,
      `CREATE TABLE projects (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL,
        repo_url text,
        default_branch text NOT NULL DEFAULT 'main',
        local_path text,
        dsn_prefix text NOT NULL,
        dsn_hash text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX projects_user_idx ON projects (user_id)`,
      `CREATE UNIQUE INDEX projects_dsn_hash_idx ON projects (dsn_hash)`,
      `CREATE TABLE events (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        fingerprint text NOT NULL,
        error_type text NOT NULL,
        message text NOT NULL,
        stack text NOT NULL,
        deploy_sha text,
        environment text,
        user_id text,
        user_email text,
        breadcrumbs_json text,
        request_json text,
        tags_json text,
        extra_json text,
        received_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX events_proj_fp_idx ON events (project_id, fingerprint, received_at)`,
      `CREATE INDEX events_proj_user_idx ON events (project_id, user_id, received_at)`,
      `CREATE TABLE cases (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        fingerprint text NOT NULL,
        error_type text NOT NULL,
        message text NOT NULL,
        status text NOT NULL DEFAULT 'open',
        event_count integer NOT NULL DEFAULT 0,
        first_seen_at integer NOT NULL DEFAULT (unixepoch()),
        last_seen_at integer NOT NULL DEFAULT (unixepoch()),
        last_deploy_sha text,
        agent_summary text,
        pr_url text
      )`,
      `CREATE UNIQUE INDEX cases_proj_fp_idx ON cases (project_id, fingerprint)`,
      `CREATE INDEX cases_proj_status_idx ON cases (project_id, status, last_seen_at)`,
      `CREATE TABLE agent_runs (
        id text PRIMARY KEY,
        case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        started_at integer NOT NULL DEFAULT (unixepoch()),
        finished_at integer,
        status text NOT NULL DEFAULT 'running',
        summary_md text,
        pr_url text,
        action text
      )`,
      `CREATE INDEX agent_runs_case_idx ON agent_runs (case_id, started_at)`,
      `CREATE TABLE suppression_entries (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        fingerprint_pattern text NOT NULL,
        action text NOT NULL,
        reason text,
        hint_text text,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX suppression_proj_idx ON suppression_entries (project_id)`,
      `CREATE TABLE deploys (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        sha text NOT NULL,
        branch text,
        environment text,
        message text,
        url text,
        actor text,
        extra_json text,
        received_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX deploys_proj_time_idx ON deploys (project_id, received_at)`,
      `CREATE TABLE posthog_projects (
        user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        posthog_project_id integer NOT NULL,
        posthog_project_api_key text NOT NULL,
        read_token_enc text NOT NULL,
        read_token_iv text NOT NULL,
        posthog_host text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX posthog_projects_ph_id_idx ON posthog_projects (posthog_project_id)`,
      `CREATE TABLE webhooks (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        url text NOT NULL,
        description text,
        events text NOT NULL,
        signing_secret_prefix text NOT NULL,
        signing_secret_hash text NOT NULL,
        active integer NOT NULL DEFAULT 1,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        last_fired_at integer,
        last_status integer,
        last_error text
      )`,
      `CREATE INDEX webhooks_proj_idx ON webhooks (project_id, active)`,
      `CREATE TABLE usage_counters (
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        period text NOT NULL,
        signal_type text NOT NULL,
        count integer NOT NULL DEFAULT 0
      )`,
      `CREATE UNIQUE INDEX usage_counters_pk ON usage_counters (project_id, period, signal_type)`,
      `CREATE TABLE usage_snapshots (
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day text NOT NULL,
        period text NOT NULL,
        errors integer NOT NULL DEFAULT 0,
        analytics integer NOT NULL DEFAULT 0,
        deploys integer NOT NULL DEFAULT 0,
        total_events integer NOT NULL DEFAULT 0,
        plan text NOT NULL DEFAULT 'free',
        captured_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX usage_snapshots_pk ON usage_snapshots (user_id, day)`,
      `CREATE INDEX usage_snapshots_day_idx ON usage_snapshots (day)`,
      `CREATE TABLE alerts (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        description text,
        recipe_id text NOT NULL,
        params_json text NOT NULL DEFAULT '{}',
        threshold_column text NOT NULL,
        threshold_op text NOT NULL,
        threshold_value text NOT NULL,
        webhook_id text,
        active integer NOT NULL DEFAULT 1,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        last_evaluated_at integer,
        last_triggered_at integer,
        last_value text
      )`,
      `CREATE INDEX alerts_proj_idx ON alerts (project_id, active)`,
      `CREATE TABLE feedback (
        id text PRIMARY KEY,
        user_id text REFERENCES users(id) ON DELETE SET NULL,
        project_id text REFERENCES projects(id) ON DELETE SET NULL,
        kind text NOT NULL DEFAULT 'other',
        message text NOT NULL,
        agent_note text,
        tool_name text,
        attempt_count integer,
        claude_session_id text,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        resolved integer NOT NULL DEFAULT 0,
        resolution text
      )`,
      `CREATE INDEX feedback_user_idx ON feedback (user_id, created_at)`,
      `CREATE INDEX feedback_kind_idx ON feedback (kind, resolved, created_at)`,
    ],
    "write",
  );

  dbByUrl.set(url, { client, drizzle: d });

  return {
    TURSO_DATABASE_URL: url,
    TURSO_AUTH_TOKEN: "",
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    ENABLE_TEST_LOGIN: opts?.enableTestLogin === false ? "false" : "true",
    ...(opts?.withEncKey ? { AGENTRY_TOKEN_ENC_KEY: TEST_ENC_KEY } : {}),
  };
}

// Module-mock helper: replace getDb so it returns the in-memory drizzle for the URL.
export function getDbForUrl(url: string) {
  const entry = dbByUrl.get(url);
  if (!entry) throw new Error(`No test DB seeded for url ${url}`);
  return entry.drizzle;
}
