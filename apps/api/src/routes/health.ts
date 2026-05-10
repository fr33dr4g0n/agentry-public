import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { cases, deploys, events, webhooks } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import { FREE_TIER_CAPS, periodFor, readUsage } from "../usage.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

router.get("/v1/projects/:project_id/health", requireApiKey(), async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);
  const db = getDb(c.env);

  const [lastEventRow] = await db
    .select({ ts: sql<number>`max(${events.receivedAt})` })
    .from(events)
    .where(eq(events.projectId, projectId));
  const [lastDeployRow] = await db
    .select({ ts: sql<number>`max(${deploys.receivedAt})` })
    .from(deploys)
    .where(eq(deploys.projectId, projectId));
  const [openCasesRow] = await db
    .select({ c: sql<number>`count(*)` })
    .from(cases)
    .where(sql`${cases.projectId} = ${projectId} AND ${cases.status} = 'open'`);
  const [eventsLastHourRow] = await db
    .select({ c: sql<number>`count(*)` })
    .from(events)
    .where(sql`${events.projectId} = ${projectId} AND ${events.receivedAt} > unixepoch() - 3600`);

  // Webhook health summary
  const hookRows = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.projectId, projectId));
  const webhookHealth = hookRows.map((w) => ({
    id: w.id,
    url: w.url,
    active: w.active === 1,
    last_status: w.lastStatus,
    last_error: w.lastError,
    last_fired_at: w.lastFiredAt,
  }));

  const usage = await readUsage(c.env, projectId);
  const period = periodFor();

  const lastEventAt = lastEventRow?.ts ?? null;
  const lastDeployAt = lastDeployRow?.ts ?? null;
  const now = Math.floor(Date.now() / 1000);
  const stalenessSeconds = lastEventAt ? now - Number(lastEventAt) : null;

  return c.json({
    project_id: projectId,
    last_event_received_at: lastEventAt,
    last_deploy_at: lastDeployAt,
    seconds_since_last_event: stalenessSeconds,
    open_cases: Number(openCasesRow?.c ?? 0),
    events_last_hour: Number(eventsLastHourRow?.c ?? 0),
    usage_this_month: {
      period,
      errors: { count: usage.errors, cap: FREE_TIER_CAPS.errors, pct: Math.round((usage.errors / FREE_TIER_CAPS.errors) * 100) },
      analytics: { count: usage.analytics, cap: FREE_TIER_CAPS.analytics, pct: Math.round((usage.analytics / FREE_TIER_CAPS.analytics) * 100) },
      deploys: { count: usage.deploys, cap: FREE_TIER_CAPS.deploys, pct: Math.round((usage.deploys / FREE_TIER_CAPS.deploys) * 100) },
    },
    webhooks: webhookHealth,
    next_action:
      stalenessSeconds !== null && stalenessSeconds > 3600
        ? "⚠ No events received in over an hour. Check that the SDK is initialized and AGENTRY_DSN is set in the running app."
        : usage.errors / FREE_TIER_CAPS.errors > 0.8 || usage.analytics / FREE_TIER_CAPS.analytics > 0.8
        ? "⚠ Approaching free-tier cap. Review usage_this_month.*.pct and consider suppression rules or upgrading."
        : "Healthy. Use this endpoint as a regular heartbeat from CI / cron.",
  });
});

export default router;
