// User-facing usage endpoint. Returns the authenticated user's current-month
// totals across all their projects, plus their plan info. Designed for the
// MCP agent to call and surface "you're at X% of plan" to the user.

import { Hono } from "hono";
import { and, desc, eq, gte } from "drizzle-orm";
import { usageSnapshots } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey } from "../middleware.js";
import { dayFor, periodFor, readUserUsage } from "../usage.js";
import { planFor } from "../plans.js";
import type { AppBindings } from "../env.js";
import type { User } from "@agentry/db/schema";

const router = new Hono<AppBindings>();

router.get("/v1/usage", requireApiKey(), async (c) => {
  const user = c.get("user") as User;
  const period = c.req.query("period") ?? periodFor();
  const usage = await readUserUsage(c.env, user.id, period);
  const plan = planFor(user.plan);
  const pct = plan.monthlyEvents > 0 ? Math.round((usage.totalEvents / plan.monthlyEvents) * 100) : 0;

  return c.json({
    period,
    plan: plan.id,
    plan_name: plan.name,
    monthly_event_cap: plan.monthlyEvents,
    retention_days: plan.retentionDays,
    total_events: usage.totalEvents,
    pct_of_plan: pct,
    breakdown: {
      errors: usage.errors,
      analytics: usage.analytics,
      deploys: usage.deploys,
    },
    next_action:
      pct > 90
        ? `You're at ${pct}% of your ${plan.name} plan's ${plan.monthlyEvents.toLocaleString()} event cap.`
        : `Healthy. ${usage.totalEvents.toLocaleString()} of ${plan.monthlyEvents.toLocaleString()} events used this period.`,
  });
});

// GET /v1/usage/history?days=30 — daily snapshots for the authenticated user.
router.get("/v1/usage/history", requireApiKey(), async (c) => {
  const user = c.get("user") as User;
  const days = Math.max(1, Math.min(365, Number(c.req.query("days") ?? "30") || 30));
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days);
  const cutoffDay = dayFor(cutoffDate);

  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(usageSnapshots)
    .where(and(eq(usageSnapshots.userId, user.id), gte(usageSnapshots.day, cutoffDay)))
    .orderBy(desc(usageSnapshots.day));

  return c.json({ days, snapshots: rows });
});

export default router;
