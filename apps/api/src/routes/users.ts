// Per-project user views. agentry tracks which user_id captured which event,
// indexed for fast questions like "how many distinct users hit this case",
// "top users by error count", "users seen in the last 24h".

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { errors } from "@agentry/shared";
import { events } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

router.use("/v1/projects/:project_id/users*", requireApiKey());

// Top users by error count over a window
router.get("/v1/projects/:project_id/users", async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);

  const days = clampInt(c.req.query("days"), 1, 90, 30);
  const limit = clampInt(c.req.query("limit"), 1, 200, 50);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const db = getDb(c.env);
  const rows = await db.all<{
    user_id: string;
    user_email: string | null;
    error_count: number;
    distinct_fingerprints: number;
    last_seen_at: number;
  }>(sql`
    SELECT
      user_id,
      max(user_email) AS user_email,
      count(*) AS error_count,
      count(DISTINCT fingerprint) AS distinct_fingerprints,
      max(received_at) AS last_seen_at
    FROM events
    WHERE project_id = ${projectId}
      AND user_id IS NOT NULL
      AND received_at > ${since}
    GROUP BY user_id
    ORDER BY error_count DESC
    LIMIT ${limit}
  `);

  const [summary] = await db.all<{ uniq: number; total: number }>(sql`
    SELECT count(DISTINCT user_id) AS uniq, count(*) AS total
    FROM events
    WHERE project_id = ${projectId}
      AND user_id IS NOT NULL
      AND received_at > ${since}
  `);

  return c.json({
    project_id: projectId,
    window_days: days,
    unique_users: Number(summary?.uniq ?? 0),
    total_events: Number(summary?.total ?? 0),
    users: rows.map((r) => ({
      user_id: r.user_id,
      user_email: r.user_email,
      error_count: Number(r.error_count),
      distinct_fingerprints: Number(r.distinct_fingerprints),
      last_seen_at: Number(r.last_seen_at),
    })),
    next_action:
      "If a user has many distinct_fingerprints, they're hitting unrelated bugs (suggesting a broader regression " +
      "for them — bad config, wrong env, fresh deploy). High error_count with low distinct_fingerprints means " +
      "one bug is very loud for one user.",
  });
});

router.get("/v1/cases/:case_id/users", requireApiKey(), async (c) => {
  const caseId = c.req.param("case_id");
  // Look up case + tenancy via existing helper in routes/cases. For simplicity
  // here, do a direct DB join with the api key's user.
  const db = getDb(c.env);
  const apiUser = c.get("user");
  const rows = await db.all<{
    user_id: string;
    user_email: string | null;
    error_count: number;
    last_seen_at: number;
    project_id: string;
    user_owner: string;
  }>(sql`
    SELECT
      e.user_id,
      max(e.user_email) AS user_email,
      count(*) AS error_count,
      max(e.received_at) AS last_seen_at,
      c.project_id,
      p.user_id AS user_owner
    FROM cases c
    JOIN events e ON e.project_id = c.project_id AND e.fingerprint = c.fingerprint
    JOIN projects p ON p.id = c.project_id
    WHERE c.id = ${caseId}
      AND e.user_id IS NOT NULL
    GROUP BY e.user_id
    ORDER BY last_seen_at DESC
    LIMIT 100
  `);
  if (rows.length === 0) {
    return c.json({ case_id: caseId, users: [], next_action: "No identified users for this case yet." });
  }
  // Tenancy: every row should share the same project owner; require it matches.
  const owner = rows[0]?.user_owner;
  if (owner !== apiUser.id) throw errors.forbidden();

  return c.json({
    case_id: caseId,
    users: rows.map((r) => ({
      user_id: r.user_id,
      user_email: r.user_email,
      error_count: Number(r.error_count),
      last_seen_at: Number(r.last_seen_at),
    })),
    next_action:
      "Use the sample user_ids to investigate user-specific patterns (auth state, account age, plan tier). " +
      "Cross-reference with analytics events from the same distinct_id to see what they did before the error.",
  });
});

function clampInt(s: string | undefined, min: number, max: number, fallback: number): number {
  const n = parseInt(s ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export default router;
