import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { errors } from "@agentry/shared";
import { cases, deploys, events } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import { isPosthogConfigured, runHogQl } from "../posthog.js";
import { getRecipe, interpolateQuery, listRecipes, RECIPES } from "../recipes.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// Catalog (no auth — public discovery doc, like /llms.txt)
// ---------------------------------------------------------------------------

router.get("/v1/recipes", (c) => {
  const category = c.req.query("category");
  const recipes = listRecipes(category ?? undefined);
  return c.json({
    count: recipes.length,
    categories: ["users", "retention", "funnels", "events", "errors", "deploys"],
    recipes: recipes.map((r) => ({
      id: r.id,
      category: r.category,
      title: r.title,
      description: r.description,
      backend: r.backend,
      params: r.params,
      expected_columns: r.expected_columns,
      render_hint: r.render_hint,
      example_user_question: r.example_user_question,
    })),
    next_action:
      "To run a recipe: POST /v1/projects/:project_id/recipes/:recipe_id/run with " +
      "{params: {...}} (api-key auth). The response includes results + render_hint " +
      "the agent uses to format the answer.",
  });
});

router.get("/v1/recipes/:id", (c) => {
  const r = getRecipe(c.req.param("id"));
  if (!r) throw errors.notFound("recipe");
  return c.json({
    ...r,
    next_action:
      `Run with: POST /v1/projects/<your_project_id>/recipes/${r.id}/run with {params: {...}}.`,
  });
});

// ---------------------------------------------------------------------------
// Execute (auth required — runs against the user's data)
// ---------------------------------------------------------------------------

router.post(
  "/v1/projects/:project_id/recipes/:recipe_id/run",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    const recipeId = c.req.param("recipe_id");
    const proj = await requireProjectAccess(c, projectId);
    const recipe = getRecipe(recipeId);
    if (!recipe) throw errors.notFound("recipe");

    let body: { params?: Record<string, unknown> } = {};
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === "object") body = raw as typeof body;
    } catch {
      // Empty body is OK for parameterless recipes.
    }
    const params = body.params ?? {};

    if (recipe.backend === "analytics") {
      if (!isPosthogConfigured(c.env)) {
        throw errors.internal(
          "Analytics recipes require PostHog. Set POSTHOG_HOST + POSTHOG_ORG_ID + " +
          "POSTHOG_MASTER_API_KEY + AGENTRY_TOKEN_ENC_KEY.",
        );
      }
      const interpolated = interpolateQuery(recipe.query, params, recipe.params);
      const out = await runHogQl(c.env, proj.userId, interpolated);
      return c.json({
        recipe_id: recipe.id,
        title: recipe.title,
        backend: "analytics",
        rows: rowsToObjects(out.results, recipe.expected_columns, out.columns),
        columns: out.columns ?? recipe.expected_columns,
        render_hint: recipe.render_hint,
        next_action:
          "Format these rows according to render_hint. " +
          "If render_hint.type is 'line' or 'bar', the agent should produce a markdown " +
          "table AND an ASCII chart (or Mermaid if supported). For 'funnel', show step " +
          "counts plus drop-off percentages between steps. For 'scalar', a one-sentence summary.",
      });
    }

    // backend === "cases"  → run against agentry's own DB
    const db = getDb(c.env);
    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit)
        ? Math.max(1, Math.min(500, Math.floor(params.limit)))
        : Number(recipe.params.find((p) => p.name === "limit")?.default ?? 50);

    let rows: Array<Record<string, unknown>>;
    let columns = recipe.expected_columns;
    switch (recipe.id) {
      case "open_cases_top": {
        const r = await db
          .select({
            id: cases.id,
            error_type: cases.errorType,
            message: cases.message,
            event_count: cases.eventCount,
            last_seen_at: cases.lastSeenAt,
            last_deploy_sha: cases.lastDeploySha,
          })
          .from(cases)
          .where(sql`${cases.projectId} = ${projectId} AND ${cases.status} = 'open'`)
          .orderBy(sql`${cases.eventCount} DESC`)
          .limit(limit);
        rows = r as Array<Record<string, unknown>>;
        break;
      }
      case "top_users_by_errors": {
        const days = clampInt(params["days"], 1, 90, 7);
        const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
        const r = await db.all<Record<string, unknown>>(sql`
          SELECT user_id, max(user_email) AS user_email, count(*) AS error_count,
                 count(DISTINCT fingerprint) AS distinct_fingerprints, max(received_at) AS last_seen_at
          FROM events
          WHERE project_id = ${projectId} AND user_id IS NOT NULL AND received_at > ${sinceTs}
          GROUP BY user_id ORDER BY error_count DESC LIMIT ${limit}
        `);
        rows = r as Array<Record<string, unknown>>;
        break;
      }
      case "unique_users_24h": {
        const r = await db.all<Record<string, unknown>>(sql`
          SELECT count(DISTINCT user_id) AS unique_users, count(*) AS total_events
          FROM events
          WHERE project_id = ${projectId}
            AND user_id IS NOT NULL
            AND received_at > unixepoch() - 86400
        `);
        rows = r as Array<Record<string, unknown>>;
        break;
      }
      case "users_affected_by_case": {
        const fingerprint = typeof params["fingerprint"] === "string" ? (params["fingerprint"] as string) : "";
        if (!fingerprint) {
          throw errors.invalidPayload({ reason: "param 'fingerprint' is required for users_affected_by_case" });
        }
        const r = await db.all<Record<string, unknown>>(sql`
          SELECT user_id, max(user_email) AS user_email, count(*) AS error_count, max(received_at) AS last_seen_at
          FROM events
          WHERE project_id = ${projectId} AND fingerprint = ${fingerprint} AND user_id IS NOT NULL
          GROUP BY user_id ORDER BY last_seen_at DESC LIMIT ${limit}
        `);
        rows = r as Array<Record<string, unknown>>;
        break;
      }
      case "errors_by_hour_24h": {
        const r = await db.all<{ hour: number; errors: number }>(sql`
          SELECT (received_at / 3600) * 3600 AS hour, count(*) AS errors
          FROM events
          WHERE project_id = ${projectId}
            AND received_at > unixepoch() - 86400
          GROUP BY hour
          ORDER BY hour
        `);
        rows = r as unknown as Array<Record<string, unknown>>;
        break;
      }
      case "errors_after_last_deploy": {
        const r = await db.all<Record<string, unknown>>(sql`
          WITH latest_deploy AS (
            SELECT max(received_at) AS deploy_ts FROM deploys WHERE project_id = ${projectId}
          )
          SELECT id, error_type, message, event_count, first_seen_at, last_deploy_sha
          FROM cases
          WHERE project_id = ${projectId}
            AND first_seen_at >= COALESCE((SELECT deploy_ts FROM latest_deploy), 0)
          ORDER BY first_seen_at DESC
        `);
        rows = r as Array<Record<string, unknown>>;
        break;
      }
      case "deploy_frequency_30d": {
        const r = await db.all<{ day: string; deploys: number }>(sql`
          SELECT date(received_at, 'unixepoch') AS day, count(*) AS deploys
          FROM deploys
          WHERE project_id = ${projectId}
            AND received_at > unixepoch() - 30 * 86400
          GROUP BY day
          ORDER BY day
        `);
        rows = r as unknown as Array<Record<string, unknown>>;
        break;
      }
      default:
        throw errors.internal(`Recipe ${recipeId} has no handler. (Add one in routes/recipes.ts.)`);
    }

    return c.json({
      recipe_id: recipe.id,
      title: recipe.title,
      backend: "cases",
      rows,
      columns,
      render_hint: recipe.render_hint,
      next_action:
        "Format these rows according to render_hint. For tables, prefer markdown. " +
        "For each open case, the agent can call agentry_get_case for stack + recent_deploys.",
    });
  },
);

// silence unused
void events;
void cases;
void deploys;
void RECIPES;
void eq;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function rowsToObjects(
  results: unknown[],
  expectedColumns: string[],
  actualColumns: string[] | null,
): Array<Record<string, unknown>> {
  // PostHog HogQL returns rows as arrays. Map them into objects using the
  // returned `columns` (preferred) or fall back to expected_columns.
  const cols = actualColumns ?? expectedColumns;
  const out: Array<Record<string, unknown>> = [];
  for (const row of results) {
    if (Array.isArray(row)) {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) obj[cols[i] ?? `col_${i}`] = row[i];
      out.push(obj);
    } else if (row && typeof row === "object") {
      out.push(row as Record<string, unknown>);
    }
  }
  return out;
}

export default router;
