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
}

// Cache so getDb() returns the same connection within one test.
const dbByUrl = new Map<
  string,
  { client: Client; drizzle: ReturnType<typeof drizzle<typeof schema>> }
>();

export async function makeTestEnv(opts?: {
  enableTestLogin?: boolean;
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
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX users_github_id_idx ON users (github_id)`,
      `CREATE INDEX users_email_idx ON users (email)`,
      `CREATE TABLE api_keys (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        prefix text NOT NULL,
        key_hash text NOT NULL,
        name text,
        last_used_at integer,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        revoked_at integer
      )`,
      `CREATE UNIQUE INDEX api_keys_hash_idx ON api_keys (key_hash)`,
      `CREATE INDEX api_keys_user_idx ON api_keys (user_id)`,
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
        breadcrumbs_json text,
        request_json text,
        tags_json text,
        extra_json text,
        received_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX events_proj_fp_idx ON events (project_id, fingerprint, received_at)`,
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
  };
}

// Module-mock helper: replace getDb so it returns the in-memory drizzle for the URL.
export function getDbForUrl(url: string) {
  const entry = dbByUrl.get(url);
  if (!entry) throw new Error(`No test DB seeded for url ${url}`);
  return entry.drizzle;
}
