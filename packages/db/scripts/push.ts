// Non-interactive schema push for Turso. Drops + recreates everything.
// v0 — destructive, only safe pre-launch.

import { createClient } from "@libsql/client";

const DROP_STATEMENTS: string[] = [
  "DROP TABLE IF EXISTS suppression_entries",
  "DROP TABLE IF EXISTS agent_runs",
  "DROP TABLE IF EXISTS cases",
  "DROP TABLE IF EXISTS events",
  "DROP TABLE IF EXISTS projects",
  "DROP TABLE IF EXISTS api_keys",
  "DROP TABLE IF EXISTS users",
];

const STATEMENTS: string[] = [
  `CREATE TABLE users (
    id text PRIMARY KEY NOT NULL,
    github_id integer NOT NULL,
    github_username text NOT NULL,
    email text,
    avatar_url text,
    created_at integer DEFAULT (unixepoch()) NOT NULL
  )`,
  `CREATE UNIQUE INDEX users_github_id_idx ON users (github_id)`,
  `CREATE INDEX users_email_idx ON users (email)`,

  `CREATE TABLE api_keys (
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
  `CREATE UNIQUE INDEX api_keys_hash_idx ON api_keys (key_hash)`,
  `CREATE INDEX api_keys_user_idx ON api_keys (user_id)`,

  `CREATE TABLE projects (
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
  `CREATE INDEX projects_user_idx ON projects (user_id)`,
  `CREATE UNIQUE INDEX projects_dsn_hash_idx ON projects (dsn_hash)`,

  `CREATE TABLE events (
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
  `CREATE INDEX events_proj_fp_idx ON events (project_id, fingerprint, received_at)`,

  `CREATE TABLE cases (
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
  `CREATE UNIQUE INDEX cases_proj_fp_idx ON cases (project_id, fingerprint)`,
  `CREATE INDEX cases_proj_status_idx ON cases (project_id, status, last_seen_at)`,

  `CREATE TABLE agent_runs (
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
  `CREATE INDEX agent_runs_case_idx ON agent_runs (case_id, started_at)`,

  `CREATE TABLE suppression_entries (
    id text PRIMARY KEY NOT NULL,
    project_id text NOT NULL,
    fingerprint_pattern text NOT NULL,
    action text NOT NULL,
    reason text,
    hint_text text,
    created_at integer DEFAULT (unixepoch()) NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE cascade
  )`,
  `CREATE INDEX suppression_proj_idx ON suppression_entries (project_id)`,
];

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });

  console.log("dropping...");
  for (const s of DROP_STATEMENTS) {
    process.stdout.write("·");
    await client.execute(s);
  }
  process.stdout.write("\n");

  console.log("creating...");
  for (const s of STATEMENTS) {
    process.stdout.write("·");
    await client.execute(s);
  }
  process.stdout.write("\n");

  const r = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  );
  console.log("tables:", r.rows.map((row) => (row as { name: string }).name).join(", "));
}

main().catch((err) => {
  console.error("push failed:", err);
  process.exit(1);
});
