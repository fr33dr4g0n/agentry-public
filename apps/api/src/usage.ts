// Usage counters keyed by (project_id, period, signal_type).
// Best-effort upsert on every ingest. Drop-on-error: monitoring should never
// crash a customer's request.

import { and, eq, sql } from "drizzle-orm";
import { projects, usageCounters, usageSnapshots, users } from "@agentry/db/schema";
import { getDb } from "./db.js";
import { planFor } from "./plans.js";
import type { Env } from "./env.js";

export type SignalType = "errors" | "analytics" | "deploys";

export function periodFor(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function dayFor(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function incrementUsage(
  env: Env,
  projectId: string,
  signalType: SignalType,
): Promise<void> {
  try {
    const db = getDb(env);
    const period = periodFor();
    // Upsert: insert with count=1, on conflict bump count.
    await db
      .insert(usageCounters)
      .values({ projectId, period, signalType, count: 1 })
      .onConflictDoUpdate({
        target: [usageCounters.projectId, usageCounters.period, usageCounters.signalType],
        set: { count: sql`${usageCounters.count} + 1` },
      });
  } catch {
    // Never let counter writes affect the main path.
  }
}

export async function readUsage(
  env: Env,
  projectId: string,
  period: string = periodFor(),
): Promise<Record<SignalType, number>> {
  const db = getDb(env);
  const rows = await db
    .select()
    .from(usageCounters)
    .where(sql`${usageCounters.projectId} = ${projectId} AND ${usageCounters.period} = ${period}`);
  const out: Record<SignalType, number> = { errors: 0, analytics: 0, deploys: 0 };
  for (const r of rows) {
    if (r.signalType === "errors" || r.signalType === "analytics" || r.signalType === "deploys") {
      out[r.signalType] = r.count;
    }
  }
  return out;
}

export interface UserUsage {
  userId: string;
  period: string;
  errors: number;
  analytics: number;
  deploys: number;
  totalEvents: number;
}

// Aggregate this user's usage across all their projects for a given period.
export async function readUserUsage(
  env: Env,
  userId: string,
  period: string = periodFor(),
): Promise<UserUsage> {
  const db = getDb(env);
  const rows = await db
    .select({
      signalType: usageCounters.signalType,
      total: sql<number>`sum(${usageCounters.count})`,
    })
    .from(usageCounters)
    .innerJoin(projects, eq(projects.id, usageCounters.projectId))
    .where(and(eq(projects.userId, userId), eq(usageCounters.period, period)))
    .groupBy(usageCounters.signalType);

  const out: UserUsage = {
    userId,
    period,
    errors: 0,
    analytics: 0,
    deploys: 0,
    totalEvents: 0,
  };
  for (const r of rows) {
    const n = Number(r.total ?? 0);
    if (r.signalType === "errors") out.errors = n;
    else if (r.signalType === "analytics") out.analytics = n;
    else if (r.signalType === "deploys") out.deploys = n;
  }
  out.totalEvents = out.errors + out.analytics + out.deploys;
  return out;
}

// Write/replace today's snapshot row for every user. Idempotent — re-running on
// the same UTC day overwrites the row. Called from the daily cron handler.
export async function snapshotAllUsers(env: Env, snapshotAt: Date = new Date()): Promise<number> {
  const db = getDb(env);
  const day = dayFor(snapshotAt);
  const period = periodFor(snapshotAt);

  const allUsers = await db.select({ id: users.id, plan: users.plan }).from(users);

  let written = 0;
  for (const u of allUsers) {
    const usage = await readUserUsage(env, u.id, period);
    await db
      .insert(usageSnapshots)
      .values({
        userId: u.id,
        day,
        period,
        errors: usage.errors,
        analytics: usage.analytics,
        deploys: usage.deploys,
        totalEvents: usage.totalEvents,
        plan: u.plan,
      })
      .onConflictDoUpdate({
        target: [usageSnapshots.userId, usageSnapshots.day],
        set: {
          period,
          errors: usage.errors,
          analytics: usage.analytics,
          deploys: usage.deploys,
          totalEvents: usage.totalEvents,
          plan: u.plan,
          capturedAt: sql`unixepoch()`,
        },
      });
    written++;
  }
  return written;
}

// Convenience: pair a user's usage with their plan limits.
export function withPlan(usage: UserUsage, planId: string | null | undefined) {
  const plan = planFor(planId);
  const pct = plan.monthlyEvents > 0 ? Math.round((usage.totalEvents / plan.monthlyEvents) * 100) : 0;
  return {
    ...usage,
    plan: {
      id: plan.id,
      name: plan.name,
      monthly_events: plan.monthlyEvents,
      retention_days: plan.retentionDays,
    },
    pct_of_plan: pct,
  };
}
