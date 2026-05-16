// Additive migration: api_keys.kind column + public_query_publications table.
// Both are idempotent — safe to re-run.
//
//   env $(grep -v '^#' apps/api/.dev.vars | xargs) node \
//     packages/db/scripts/migrate-add-public-keys.ts

import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken });

  // 1. api_keys.kind — text NOT NULL DEFAULT 'private'.
  const apiKeysInfo = await client.execute("PRAGMA table_info(api_keys)");
  const apiKeyCols = apiKeysInfo.rows.map((r) => (r as { name: string }).name);
  if (apiKeyCols.includes("kind")) {
    console.log("api_keys.kind already exists — skipping.");
  } else {
    await client.execute("ALTER TABLE api_keys ADD COLUMN kind text NOT NULL DEFAULT 'private'");
    console.log("added api_keys.kind text DEFAULT 'private'.");
    await client.execute(
      "CREATE INDEX IF NOT EXISTS api_keys_user_kind_idx ON api_keys (user_id, kind)",
    );
    console.log("created api_keys_user_kind_idx.");
  }

  // 2. public_query_publications table.
  const existing = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='public_query_publications'",
  );
  if (existing.rows.length > 0) {
    console.log("public_query_publications already exists — skipping.");
    return;
  }
  await client.execute(`
    CREATE TABLE public_query_publications (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      recipe_id text NOT NULL,
      params_json text NOT NULL DEFAULT '{}',
      description text,
      created_at integer DEFAULT (unixepoch()) NOT NULL,
      last_used_at integer,
      revoked_at integer
    )
  `);
  await client.execute("CREATE INDEX pubq_user_idx ON public_query_publications (user_id)");
  await client.execute("CREATE INDEX pubq_project_idx ON public_query_publications (project_id)");
  console.log("created public_query_publications table + indexes.");
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
