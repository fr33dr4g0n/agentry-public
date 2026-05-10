// Usage counters keyed by (project_id, period, signal_type).
// Best-effort upsert on every ingest. Drop-on-error: monitoring should never
// crash a customer's request.

import { sql } from "drizzle-orm";
import { usageCounters } from "@agentry/db/schema";
import { getDb } from "./db.js";
import type { Env } from "./env.js";

export type SignalType = "errors" | "analytics" | "deploys";

export const FREE_TIER_CAPS: Record<SignalType, number> = {
  errors: 5_000,
  analytics: 50_000,
  deploys: 500,
};

export function periodFor(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
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
