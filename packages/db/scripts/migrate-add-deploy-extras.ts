// Additive, idempotent migration: ALTER TABLE deploys ADD COLUMN extra_json text.
//
// This was applied to production via this script on 2026-05-10. The matching
// CREATE TABLE in push.ts already includes the column, so a fresh push.ts run
// produces the same schema.
//
// Run with:
//   env $(grep -v '^#' apps/api/.dev.vars | xargs) node packages/db/scripts/migrate-add-deploy-extras.ts
// (Or wire into your CI / wrangler deploy step.)

import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });

  // Idempotent: skip if the column already exists. SQLite's PRAGMA table_info
  // is the only standard way to introspect columns.
  const info = await client.execute("PRAGMA table_info(deploys)");
  const existing = info.rows.map((r) => (r as { name: string }).name);
  if (existing.includes("extra_json")) {
    console.log("extra_json already exists on deploys — no-op.");
    return;
  }

  await client.execute("ALTER TABLE deploys ADD COLUMN extra_json text");
  console.log("added extra_json text to deploys.");

  const after = await client.execute("PRAGMA table_info(deploys)");
  console.log(
    "deploys columns now:",
    after.rows.map((r) => (r as { name: string }).name).join(", "),
  );
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
