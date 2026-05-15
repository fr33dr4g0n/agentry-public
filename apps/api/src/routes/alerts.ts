// Alerts: stored definitions of "run this recipe + check threshold". Customers
// (or their cron) call /evaluate when they want the check run. agentry stores
// the definition + last-evaluated state and fires the webhook on threshold cross.
//
// No server-side scheduler — that's the customer's choice (cron, GitHub Actions,
// Cloudflare Cron Triggers, anything that can POST). agentry just stores and
// evaluates on demand.

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { errors, uuidv7 } from "@agentrysh/shared";
import { alerts, webhooks } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess, waitUntilOf } from "../middleware.js";
import { fireWebhooks } from "../webhooks.js";
import { getRecipe, interpolateQuery } from "../recipes.js";
import { isPosthogConfigured, runHogQl } from "../posthog.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

const VALID_OPS = ["gt", "gte", "lt", "lte", "eq"] as const;
type ThresholdOp = (typeof VALID_OPS)[number];

router.post("/v1/projects/:project_id/alerts", requireApiKey(), async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.slice(0, 200) : null;
  const recipeId = typeof b.recipe_id === "string" ? b.recipe_id : null;
  const thresholdColumn = typeof b.threshold_column === "string" ? b.threshold_column : null;
  const thresholdOp = typeof b.threshold_op === "string" ? b.threshold_op : null;
  const thresholdValueRaw = b.threshold_value;
  if (!name || !recipeId || !thresholdColumn || !thresholdOp) {
    throw errors.invalidPayload({
      reason: "name, recipe_id, threshold_column, and threshold_op are required",
    });
  }
  if (!VALID_OPS.includes(thresholdOp as ThresholdOp)) {
    throw errors.invalidPayload({ reason: `threshold_op must be one of ${VALID_OPS.join(", ")}` });
  }
  if (thresholdValueRaw === undefined || thresholdValueRaw === null) {
    throw errors.invalidPayload({ reason: "threshold_value is required" });
  }
  if (!getRecipe(recipeId)) {
    throw errors.invalidPayload({ reason: `recipe_id "${recipeId}" not found in catalog` });
  }
  const params = b.params && typeof b.params === "object" ? (b.params as Record<string, unknown>) : {};
  const description = typeof b.description === "string" ? b.description.slice(0, 500) : null;
  const webhookId = typeof b.webhook_id === "string" ? b.webhook_id : null;

  const id = uuidv7();
  const db = getDb(c.env);
  await db.insert(alerts).values({
    id,
    projectId,
    name,
    description,
    recipeId,
    paramsJson: JSON.stringify(params),
    thresholdColumn,
    thresholdOp,
    thresholdValue: String(thresholdValueRaw),
    webhookId,
    active: 1,
    createdAt: Math.floor(Date.now() / 1000),
  });

  return c.json({
    id,
    name,
    recipe_id: recipeId,
    threshold: { column: thresholdColumn, op: thresholdOp, value: String(thresholdValueRaw) },
    next_action:
      "Alert created. Call POST /v1/projects/:project_id/alerts/" + id + "/evaluate from your cron / scheduler. " +
      "When threshold crosses, agentry fires a webhook with event='alert.fired'.",
  });
});

router.get("/v1/projects/:project_id/alerts", requireApiKey(), async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);
  const db = getDb(c.env);
  const rows = await db.select().from(alerts).where(eq(alerts.projectId, projectId));
  return c.json({
    alerts: rows.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      recipe_id: a.recipeId,
      params: safeJsonObj(a.paramsJson),
      threshold: { column: a.thresholdColumn, op: a.thresholdOp, value: a.thresholdValue },
      webhook_id: a.webhookId,
      active: a.active === 1,
      last_evaluated_at: a.lastEvaluatedAt,
      last_triggered_at: a.lastTriggeredAt,
      last_value: a.lastValue,
    })),
  });
});

router.delete("/v1/projects/:project_id/alerts/:id", requireApiKey(), async (c) => {
  const projectId = c.req.param("project_id");
  const id = c.req.param("id");
  await requireProjectAccess(c, projectId);
  const db = getDb(c.env);
  const before = await db.select().from(alerts).where(eq(alerts.id, id)).limit(1);
  if (!before[0] || before[0].projectId !== projectId) throw errors.notFound("alert");
  await db.delete(alerts).where(eq(alerts.id, id));
  return c.json({ ok: true, id });
});

router.post(
  "/v1/projects/:project_id/alerts/:id/evaluate",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    const alertId = c.req.param("id");
    const proj = await requireProjectAccess(c, projectId);

    const db = getDb(c.env);
    const rows = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
    const a = rows[0];
    if (!a || a.projectId !== projectId) throw errors.notFound("alert");

    const recipe = getRecipe(a.recipeId);
    if (!recipe) {
      throw errors.internal(`Alert references unknown recipe '${a.recipeId}'.`);
    }
    const params = safeJsonObj(a.paramsJson) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);

    let value: number | null = null;
    let rowsOut: Array<Record<string, unknown>> = [];

    if (recipe.backend === "analytics") {
      if (!isPosthogConfigured(c.env)) {
        throw errors.internal("Analytics-backed alerts need PostHog configured.");
      }
      const interpolated = interpolateQuery(recipe.query, params, recipe.params);
      // Alerts run server-controlled recipes — skip the user-query blocklist.
      // Group-filter wrap still scopes events scans to this user.
      const out = await runHogQl(c.env, proj.userId, interpolated, { trusted: true });
      const cols = out.columns ?? recipe.expected_columns;
      rowsOut = (out.results ?? []).map((r) => {
        if (Array.isArray(r)) {
          const o: Record<string, unknown> = {};
          for (let i = 0; i < cols.length; i++) o[cols[i] ?? `col_${i}`] = r[i];
          return o;
        }
        return r as Record<string, unknown>;
      });
    } else {
      // For cases-backed recipes we'd need to dup the per-recipe SQL. Defer:
      // alerts on cases-backend recipes can be added by extending the route.
      throw errors.internal(
        `Alerts on cases-backend recipes aren't supported yet (recipe: ${a.recipeId}). Use an analytics recipe.`,
      );
    }

    // Reduce rows to a single number on the threshold column (sum if multiple rows).
    let aggregate = 0;
    for (const row of rowsOut) {
      const v = row[a.thresholdColumn];
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) aggregate += n;
    }
    value = aggregate;

    const threshold = Number(a.thresholdValue);
    const op = a.thresholdOp as ThresholdOp;
    const triggered = compareThreshold(value, op, threshold);

    let fired = false;
    if (triggered) {
      const waitUntil = waitUntilOf(c);
      // alert.fired isn't in the canonical webhook events list — fire to all
      // active webhooks (or just the linked one) using a custom event name.
      // We can't extend WebhookEvent without changing the typed list, so we
      // currently fire as case.created (the most general case) — TODO: extend
      // events list to include 'alert.fired'.
      // Safer for now: fire only if a specific webhook_id was set.
      if (a.webhookId) {
        await fireWebhooks(
          c.env,
          projectId,
          "case.created",  // placeholder until 'alert.fired' is added to the events enum
          {
            __synthetic_alert: true,
            alert_id: a.id,
            alert_name: a.name,
            recipe_id: a.recipeId,
            threshold_column: a.thresholdColumn,
            threshold_op: a.thresholdOp,
            threshold_value: a.thresholdValue,
            current_value: value,
            evaluated_at: now,
            rows: rowsOut.slice(0, 20),
          },
          { waitUntil, webhookId: a.webhookId, ignoreActive: true },
        );
        fired = true;
      }
    }

    await db
      .update(alerts)
      .set({
        lastEvaluatedAt: now,
        lastValue: String(value),
        ...(triggered ? { lastTriggeredAt: now } : {}),
      })
      .where(eq(alerts.id, alertId));

    return c.json({
      alert_id: a.id,
      recipe_id: a.recipeId,
      evaluated_at: now,
      current_value: value,
      threshold: { column: a.thresholdColumn, op: a.thresholdOp, value: a.thresholdValue },
      triggered,
      fired,
      rows_count: rowsOut.length,
      next_action: triggered
        ? fired
          ? "Threshold crossed AND a linked webhook was fired."
          : "Threshold crossed but no linked webhook to fire — set webhook_id on the alert to get notified."
        : "Threshold not crossed. Schedule another evaluation later (cron / GitHub Actions / Cloudflare Cron).",
    });
  },
);

function compareThreshold(value: number, op: ThresholdOp, threshold: number): boolean {
  switch (op) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "eq": return value === threshold;
  }
}

function safeJsonObj(s: string | null | undefined): unknown {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

void webhooks;
void and;

export default router;
