// Additive, idempotent migration: CREATE TABLE sourcemaps + its indexes.
//
// Stores the index of uploaded browser sourcemaps (the .map blobs live in R2;
// this table indexes them by (project_id, release_id, source_url) for fast
// translate-time lookup).
//
// Run with:
//   env $(grep -v '^#' apps/api/.dev.vars | xargs) node packages/db/scripts/migrate-add-sourcemaps.ts

import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });

  // Idempotent check.
  const existing = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sourcemaps'",
  );
  if (existing.rows.length > 0) {
    console.log("sourcemaps table already exists — no-op.");
    return;
  }

  await client.execute(`
    CREATE TABLE sourcemaps (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      release_id text NOT NULL,
      source_url text NOT NULL,
      r2_key text NOT NULL,
      size_bytes integer NOT NULL,
      uploaded_at integer DEFAULT (unixepoch()) NOT NULL
    )
  `);
  console.log("created sourcemaps table.");

  await client.execute(
    "CREATE INDEX sourcemaps_proj_release_idx ON sourcemaps (project_id, release_id)",
  );
  await client.execute(
    "CREATE UNIQUE INDEX sourcemaps_lookup_idx ON sourcemaps (project_id, release_id, source_url)",
  );
  console.log("created sourcemaps indexes.");
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
