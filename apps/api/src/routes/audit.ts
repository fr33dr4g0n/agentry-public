// Read-side of the audit log.
//
// GET /v1/audit/recent?hours=24
// Lists the user's audit-log rows in the last N hours (default 24, max 720).
// Filterable by action prefix (e.g. "feature_flag.") and resource_type.

import { Hono } from "hono";
import { and, desc, eq, gte, like } from "drizzle-orm";
import { auditLog } from "@agentry/db/schema";
import { errors } from "@agentrysh/shared";
import { getDb } from "../db.js";
import { requireApiKey } from "../middleware.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

router.get("/v1/audit/recent", requireApiKey(), async (c) => {
  const user = c.get("user");
  const hoursRaw = c.req.query("hours");
  const hours = hoursRaw ? Number(hoursRaw) : 24;
  if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
    throw errors.invalidPayload({
      reason: "hours must be 1..720 (max 30 days). default 24.",
    });
  }
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200), 1), 500);
  const actionPrefix = c.req.query("action_prefix")?.trim();
  const resourceType = c.req.query("resource_type")?.trim();
  const projectId = c.req.query("project_id")?.trim();
  const since = Math.floor(Date.now() / 1000) - Math.floor(hours * 3600);

  const conds = [eq(auditLog.userId, user.id), gte(auditLog.at, since)];
  if (actionPrefix) conds.push(like(auditLog.action, `${actionPrefix}%`));
  if (resourceType) conds.push(eq(auditLog.resourceType, resourceType));
  if (projectId) conds.push(eq(auditLog.projectId, projectId));

  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...conds))
    .orderBy(desc(auditLog.at))
    .limit(limit);

  return c.json({
    hours,
    since,
    count: rows.length,
    actions: rows.map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      resource_type: r.resourceType,
      resource_id: r.resourceId,
      project_id: r.projectId,
      summary: r.summary,
      ip: r.ip,
      ua: r.ua ? r.ua.slice(0, 80) : null,
      metadata: r.metadataJson ? safeJson(r.metadataJson) : null,
    })),
    next_action:
      rows.length === 0
        ? `No agent-driven changes in the last ${hours}h.`
        : `Last ${rows.length} mutation${rows.length === 1 ? "" : "s"}, newest first. Pass action_prefix=feature_flag./cohort./survey./publication./session_replay. or resource_type to filter, hours=N to widen the window (max 720).`,
  });
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export default router;
