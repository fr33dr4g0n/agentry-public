// Additive migration: audit_log table.
// Idempotent — safe to re-run.
//
//   env $(grep -v '^#' apps/api/.dev.vars | xargs) node \
//     packages/db/scripts/migrate-add-audit-log.ts

import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken });

  const existing = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'",
  );
  if (existing.rows.length > 0) {
    console.log("audit_log already exists — skipping.");
    return;
  }
  await client.execute(`
    CREATE TABLE audit_log (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id text REFERENCES projects(id) ON DELETE SET NULL,
      action text NOT NULL,
      resource_type text NOT NULL,
      resource_id text,
      summary text,
      metadata_json text,
      ip text,
      ua text,
      at integer DEFAULT (unixepoch()) NOT NULL
    )
  `);
  await client.execute("CREATE INDEX audit_user_time_idx ON audit_log (user_id, at)");
  await client.execute("CREATE INDEX audit_proj_time_idx ON audit_log (project_id, at)");
  await client.execute("CREATE INDEX audit_action_idx ON audit_log (user_id, action, at)");
  console.log("created audit_log table + indexes.");
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
