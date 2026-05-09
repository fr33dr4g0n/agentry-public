// Test bootstrap — builds an in-memory libsql DB and stubs the api's getDb()
// to return it for the lifetime of one test.

import { createClient as createLibsql, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentry/db/schema";

export interface TestEnv {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  ALLOW_UNVERIFIED_SIGNUP: string;
}

// Cache so getDb() returns the same connection within one test.
const dbByUrl = new Map<
  string,
  { client: Client; drizzle: ReturnType<typeof drizzle<typeof schema>> }
>();

export async function makeTestEnv(opts?: {
  allowSignup?: boolean;
}): Promise<TestEnv> {
  const url = `:memory:#${Math.random().toString(36).slice(2)}`;
  const client = createLibsql({ url: ":memory:" });
  const d = drizzle(client, { schema });

  // Apply schema. Mirrors packages/db/src/schema.ts.
  await client.batch(
    [
      `CREATE TABLE users (
        id text PRIMARY KEY,
        email text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX users_email_idx ON users (email)`,
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
    ],
    "write",
  );

  dbByUrl.set(url, { client, drizzle: d });

  return {
    TURSO_DATABASE_URL: url,
    TURSO_AUTH_TOKEN: "",
    ALLOW_UNVERIFIED_SIGNUP: opts?.allowSignup === false ? "false" : "true",
  };
}

// Module-mock helper: replace getDb so it returns the in-memory drizzle for the URL.
export function getDbForUrl(url: string) {
  const entry = dbByUrl.get(url);
  if (!entry) throw new Error(`No test DB seeded for url ${url}`);
  return entry.drizzle;
}
