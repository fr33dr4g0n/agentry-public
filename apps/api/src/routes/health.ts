import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { cases, deploys, events, webhooks } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import { periodFor, readUsage, readUserUsage } from "../usage.js";
import { planFor } from "../plans.js";
import type { AppBindings } from "../env.js";
import type { User } from "@agentry/db/schema";

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

  const projectUsage = await readUsage(c.env, projectId);
  const period = periodFor();

  // Plan limits apply per-user across all their projects, so the cap and pct
  // shown here reflect the *account total*, not just this project's slice.
  const user = c.get("user") as User;
  const accountUsage = await readUserUsage(c.env, user.id, period);
  const plan = planFor(user.plan);
  const accountPct =
    plan.monthlyEvents > 0
      ? Math.round((accountUsage.totalEvents / plan.monthlyEvents) * 100)
      : 0;

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
      project: {
        errors: projectUsage.errors,
        analytics: projectUsage.analytics,
        deploys: projectUsage.deploys,
        total: projectUsage.errors + projectUsage.analytics + projectUsage.deploys,
      },
      account: {
        plan: plan.id,
        plan_name: plan.name,
        monthly_event_cap: plan.monthlyEvents,
        retention_days: plan.retentionDays,
        total_events: accountUsage.totalEvents,
        pct_of_plan: accountPct,
        breakdown: {
          errors: accountUsage.errors,
          analytics: accountUsage.analytics,
          deploys: accountUsage.deploys,
        },
      },
    },
    webhooks: webhookHealth,
    next_action:
      stalenessSeconds !== null && stalenessSeconds > 3600
        ? "⚠ No events received in over an hour. Check that the SDK is initialized and AGENTRY_DSN is set in the running app."
        : accountPct > 80
        ? `⚠ At ${accountPct}% of your ${plan.name} plan's monthly event cap. Review usage or consider upgrading.`
        : "Healthy. Use this endpoint as a regular heartbeat from CI / cron.",
  });
});

export default router;
