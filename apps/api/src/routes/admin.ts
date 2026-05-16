// Admin-only endpoints for inspecting usage across all users.
// Auth: ADMIN_TOKEN env secret. If unset, all /admin/* requests get 404 to
// avoid advertising the surface.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { errors } from "@agentrysh/shared";
import { projects, usageCounters, usageSnapshots, users } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { dayFor, periodFor, readUserUsage, snapshotAllUsers } from "../usage.js";
import { planFor } from "../plans.js";
import type { AppBindings } from "../env.js";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireAdmin(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const expected = c.env.ADMIN_TOKEN;
    // If no admin token is configured, refuse with 404 — don't leak that the
    // surface exists.
    if (!expected || expected.length === 0) throw errors.notFound("route");

    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    const m = auth?.match(/^Bearer\s+(.+)$/i);
    const presented = m?.[1]?.trim() ?? "";
    if (!presented || !timingSafeEqual(presented, expected)) {
      throw errors.unauthorized();
    }
    await next();
  };
}

const router = new Hono<AppBindings>();

// GET /admin/usage?period=YYYY-MM
// Returns each user's current-period totals across all their projects, with
// plan info. Sorted by total events descending.
router.get("/admin/usage", requireAdmin(), async (c) => {
  const period = c.req.query("period") ?? periodFor();
  const db = getDb(c.env);

  // One round-trip: aggregate counters joined to projects+users, grouped by
  // (user, signal_type), then fold in user metadata in JS.
  const rows = await db
    .select({
      userId: projects.userId,
      signalType: usageCounters.signalType,
      total: sql<number>`sum(${usageCounters.count})`,
    })
    .from(usageCounters)
    .innerJoin(projects, eq(projects.id, usageCounters.projectId))
    .where(eq(usageCounters.period, period))
    .groupBy(projects.userId, usageCounters.signalType);

  const byUser = new Map<string, { errors: number; analytics: number; deploys: number }>();
  for (const r of rows) {
    const u = byUser.get(r.userId) ?? { errors: 0, analytics: 0, deploys: 0 };
    const n = Number(r.total ?? 0);
    if (r.signalType === "errors") u.errors = n;
    else if (r.signalType === "analytics") u.analytics = n;
    else if (r.signalType === "deploys") u.deploys = n;
    byUser.set(r.userId, u);
  }

  // Fetch user metadata for everyone who has usage. (Users with zero usage
  // aren't included — that's fine for a usage dashboard.)
  const userIds = Array.from(byUser.keys());
  const userRows = userIds.length
    ? await db
        .select({
          id: users.id,
          email: users.email,
          githubUsername: users.githubUsername,
          plan: users.plan,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(sql`${users.id} IN ${userIds}`)
    : [];

  const out = userRows
    .map((u) => {
      const usage = byUser.get(u.id) ?? { errors: 0, analytics: 0, deploys: 0 };
      const totalEvents = usage.errors + usage.analytics + usage.deploys;
      const plan = planFor(u.plan);
      return {
        user_id: u.id,
        email: u.email,
        github_username: u.githubUsername,
        created_at: u.createdAt,
        plan: plan.id,
        plan_name: plan.name,
        monthly_event_cap: plan.monthlyEvents,
        retention_days: plan.retentionDays,
        period,
        errors: usage.errors,
        analytics: usage.analytics,
        deploys: usage.deploys,
        total_events: totalEvents,
        pct_of_plan: plan.monthlyEvents > 0 ? Math.round((totalEvents / plan.monthlyEvents) * 100) : 0,
      };
    })
    .sort((a, b) => b.total_events - a.total_events);

  return c.json({
    period,
    user_count: out.length,
    grand_total: out.reduce((s, u) => s + u.total_events, 0),
    users: out,
  });
});

// GET /admin/usage/:user_id?period=YYYY-MM
// Detailed view: per-project breakdown for a single user.
router.get("/admin/usage/:user_id", requireAdmin(), async (c) => {
  const userId = c.req.param("user_id");
  const period = c.req.query("period") ?? periodFor();
  const db = getDb(c.env);

  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = userRows[0];
  if (!user) throw errors.notFound("user");

  const usage = await readUserUsage(c.env, userId, period);

  const perProject = await db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      signalType: usageCounters.signalType,
      count: usageCounters.count,
    })
    .from(usageCounters)
    .innerJoin(projects, eq(projects.id, usageCounters.projectId))
    .where(and(eq(projects.userId, userId), eq(usageCounters.period, period)));

  const byProject = new Map<
    string,
    { id: string; name: string; errors: number; analytics: number; deploys: number }
  >();
  for (const r of perProject) {
    const p = byProject.get(r.projectId) ?? {
      id: r.projectId,
      name: r.projectName,
      errors: 0,
      analytics: 0,
      deploys: 0,
    };
    if (r.signalType === "errors") p.errors = r.count;
    else if (r.signalType === "analytics") p.analytics = r.count;
    else if (r.signalType === "deploys") p.deploys = r.count;
    byProject.set(r.projectId, p);
  }

  const plan = planFor(user.plan);
  return c.json({
    user_id: user.id,
    email: user.email,
    github_username: user.githubUsername,
    created_at: user.createdAt,
    plan: plan.id,
    plan_name: plan.name,
    monthly_event_cap: plan.monthlyEvents,
    retention_days: plan.retentionDays,
    period,
    total_events: usage.totalEvents,
    pct_of_plan: plan.monthlyEvents > 0 ? Math.round((usage.totalEvents / plan.monthlyEvents) * 100) : 0,
    breakdown: { errors: usage.errors, analytics: usage.analytics, deploys: usage.deploys },
    projects: Array.from(byProject.values())
      .map((p) => ({ ...p, total: p.errors + p.analytics + p.deploys }))
      .sort((a, b) => b.total - a.total),
  });
});

// GET /admin/usage/snapshots?days=30&user_id=...
// Returns daily snapshot rows for charting growth. Without user_id, returns
// system-wide daily totals; with user_id, returns just that user's series.
router.get("/admin/usage/snapshots", requireAdmin(), async (c) => {
  const days = Math.max(1, Math.min(365, Number(c.req.query("days") ?? "30") || 30));
  const userId = c.req.query("user_id");
  const db = getDb(c.env);

  // ISO day cutoff
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days);
  const cutoffDay = dayFor(cutoffDate);

  if (userId) {
    const rows = await db
      .select()
      .from(usageSnapshots)
      .where(and(eq(usageSnapshots.userId, userId), gte(usageSnapshots.day, cutoffDay)))
      .orderBy(desc(usageSnapshots.day));
    return c.json({ user_id: userId, days, snapshots: rows });
  }

  // System-wide: sum across users per day.
  const rows = await db
    .select({
      day: usageSnapshots.day,
      users: sql<number>`count(distinct ${usageSnapshots.userId})`,
      errors: sql<number>`sum(${usageSnapshots.errors})`,
      analytics: sql<number>`sum(${usageSnapshots.analytics})`,
      deploys: sql<number>`sum(${usageSnapshots.deploys})`,
      totalEvents: sql<number>`sum(${usageSnapshots.totalEvents})`,
    })
    .from(usageSnapshots)
    .where(gte(usageSnapshots.day, cutoffDay))
    .groupBy(usageSnapshots.day)
    .orderBy(desc(usageSnapshots.day));

  return c.json({
    days,
    snapshots: rows.map((r) => ({
      day: r.day,
      active_users: Number(r.users ?? 0),
      errors: Number(r.errors ?? 0),
      analytics: Number(r.analytics ?? 0),
      deploys: Number(r.deploys ?? 0),
      total_events: Number(r.totalEvents ?? 0),
    })),
  });
});

// POST /admin/usage/snapshot — force a snapshot now (for debugging or backfill).
router.post("/admin/usage/snapshot", requireAdmin(), async (c) => {
  const written = await snapshotAllUsers(c.env);
  return c.json({ written, day: dayFor() });
});

// GET /admin/plans — what plans exist + their limits. Cheap convenience.
router.get("/admin/plans", requireAdmin(), async (_c) => {
  const { PLANS } = await import("../plans.js");
  return Response.json({ plans: PLANS });
});

// PATCH /admin/users/:user_id/plan — move a user between plans.
// Body: { plan: "free" | "pro" | "scale" }
router.patch("/admin/users/:user_id/plan", requireAdmin(), async (c: Context<AppBindings>) => {
  const userId = c.req.param("user_id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  const planId = (body as { plan?: unknown })?.plan;
  if (typeof planId !== "string" || !(planId === "free" || planId === "pro" || planId === "scale")) {
    throw errors.invalidPayload({ reason: "plan must be one of: free, pro, scale" });
  }

  const db = getDb(c.env);
  const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!existing[0]) throw errors.notFound("user");

  await db.update(users).set({ plan: planId }).where(eq(users.id, userId));
  return c.json({ user_id: userId, plan: planId });
});

export default router;
