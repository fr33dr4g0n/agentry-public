// Additive, idempotent migration:
//   1. ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free'
//   2. CREATE TABLE usage_snapshots (...) + indexes
//
// Both steps are safe to re-run.
//
// Run with:
//   env $(grep -v '^#' apps/api/.dev.vars | xargs) node packages/db/scripts/migrate-add-plan-and-snapshots.ts

import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });

  // 1. users.plan column
  const usersInfo = await client.execute("PRAGMA table_info(users)");
  const userCols = usersInfo.rows.map((r) => (r as { name: string }).name);
  if (userCols.includes("plan")) {
    console.log("users.plan already exists — skipping ALTER.");
  } else {
    await client.execute(
      "ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free'",
    );
    console.log("added users.plan (default 'free').");
  }

  // 2. usage_snapshots table
  const tableCheck = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='usage_snapshots'",
  );
  if (tableCheck.rows.length > 0) {
    console.log("usage_snapshots table already exists — skipping CREATE.");
  } else {
    await client.execute(`CREATE TABLE usage_snapshots (
      user_id text NOT NULL,
      day text NOT NULL,
      period text NOT NULL,
      errors integer NOT NULL DEFAULT 0,
      analytics integer NOT NULL DEFAULT 0,
      deploys integer NOT NULL DEFAULT 0,
      total_events integer NOT NULL DEFAULT 0,
      plan text NOT NULL DEFAULT 'free',
      captured_at integer NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE cascade
    )`);
    await client.execute(
      "CREATE UNIQUE INDEX usage_snapshots_pk ON usage_snapshots (user_id, day)",
    );
    await client.execute(
      "CREATE INDEX usage_snapshots_day_idx ON usage_snapshots (day)",
    );
    console.log("created usage_snapshots + indexes.");
  }

  // Verify final state.
  const u = await client.execute("PRAGMA table_info(users)");
  console.log(
    "users columns:",
    u.rows.map((r) => (r as { name: string }).name).join(", "),
  );
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  console.log(
    "tables:",
    tables.rows.map((r) => (r as { name: string }).name).join(", "),
  );
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
