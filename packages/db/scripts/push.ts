// Non-interactive schema push for Turso. Runs the same CREATE TABLE statements
// drizzle-kit would, but without an interactive confirmation prompt.

import { createClient } from "@libsql/client";

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY NOT NULL,
    email text NOT NULL,
    created_at integer DEFAULT (unixepoch()) NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email)`,

  `CREATE TABLE IF NOT EXISTS api_keys (
    id text PRIMARY KEY NOT NULL,
    user_id text NOT NULL,
    prefix text NOT NULL,
    key_hash text NOT NULL,
    name text,
    last_used_at integer,
    created_at integer DEFAULT (unixepoch()) NOT NULL,
    revoked_at integer,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE cascade
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (key_hash)`,
  `CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id)`,

  `CREATE TABLE IF NOT EXISTS projects (
    id text PRIMARY KEY NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    repo_url text,
    default_branch text DEFAULT 'main' NOT NULL,
    local_path text,
    dsn_prefix text NOT NULL,
    dsn_hash text NOT NULL,
    created_at integer DEFAULT (unixepoch()) NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE cascade
  )`,
  `CREATE INDEX IF NOT EXISTS projects_user_idx ON projects (user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS projects_dsn_hash_idx ON projects (dsn_hash)`,

  `CREATE TABLE IF NOT EXISTS events (
    id text PRIMARY KEY NOT NULL,
    project_id text NOT NULL,
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
    received_at integer DEFAULT (unixepoch()) NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE cascade
  )`,
  `CREATE INDEX IF NOT EXISTS events_proj_fp_idx ON events (project_id, fingerprint, received_at)`,

  `CREATE TABLE IF NOT EXISTS cases (
    id text PRIMARY KEY NOT NULL,
    project_id text NOT NULL,
    fingerprint text NOT NULL,
    error_type text NOT NULL,
    message text NOT NULL,
    status text DEFAULT 'open' NOT NULL,
    event_count integer DEFAULT 0 NOT NULL,
    first_seen_at integer DEFAULT (unixepoch()) NOT NULL,
    last_seen_at integer DEFAULT (unixepoch()) NOT NULL,
    last_deploy_sha text,
    agent_summary text,
    pr_url text,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE cascade
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cases_proj_fp_idx ON cases (project_id, fingerprint)`,
  `CREATE INDEX IF NOT EXISTS cases_proj_status_idx ON cases (project_id, status, last_seen_at)`,

  `CREATE TABLE IF NOT EXISTS agent_runs (
    id text PRIMARY KEY NOT NULL,
    case_id text NOT NULL,
    started_at integer DEFAULT (unixepoch()) NOT NULL,
    finished_at integer,
    status text DEFAULT 'running' NOT NULL,
    summary_md text,
    pr_url text,
    action text,
    FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE cascade
  )`,
  `CREATE INDEX IF NOT EXISTS agent_runs_case_idx ON agent_runs (case_id, started_at)`,

  `CREATE TABLE IF NOT EXISTS suppression_entries (
    id text PRIMARY KEY NOT NULL,
    project_id text NOT NULL,
    fingerprint_pattern text NOT NULL,
    action text NOT NULL,
    reason text,
    hint_text text,
    created_at integer DEFAULT (unixepoch()) NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE cascade
  )`,
  `CREATE INDEX IF NOT EXISTS suppression_proj_idx ON suppression_entries (project_id)`,
];

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });

  for (const stmt of STATEMENTS) {
    process.stdout.write("…");
    await client.execute(stmt);
  }
  process.stdout.write("\n");

  // Smoke check.
  const r = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  console.log("tables:", r.rows.map((row) => (row as { name: string }).name).join(", "));
}

main().catch((err) => {
  console.error("push failed:", err);
  process.exit(1);
});
