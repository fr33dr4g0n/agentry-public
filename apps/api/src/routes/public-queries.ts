// Public-fetchable recipe publications.
//
// The user (via their agent) calls `agentry_publish_query` to mint a
// publication for a (recipe_id, params) tuple. The publication has its own
// unguessable UUID. Visitors fetch:
//
//   GET /v1/public/q/<publication_id>?key=agp_<…>
//
// …and get the recipe's results, scoped to the user's PostHog team
// (PostHog enforces team_id on every events read at the AST level — same
// isolation as the user's private queries).
//
// Two safety layers:
//   1. agp_ key auths the request; only the OWNING user's agp_ key works.
//   2. publication_id is unguessable AND only exists for queries the user
//      explicitly published. The agp_ key alone is useless without the id.
//
// CORS is open on the public endpoint — meant to be called from browsers.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { and, desc, eq, isNull } from "drizzle-orm";
import { errors, sha256Hex, uuidv7 } from "@agentrysh/shared";
import { apiKeys, publicQueryPublications, projects } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import { getRecipe, interpolateQuery } from "../recipes.js";
import { isPosthogConfigured, runHogQl } from "../posthog.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// Owner-side management (api-key auth) — list / publish / revoke.
// ---------------------------------------------------------------------------

router.post(
  "/v1/projects/:project_id/public-queries",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    const proj = await requireProjectAccess(c, projectId);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      throw errors.invalidPayload({ reason: "body must be JSON" });
    }
    const recipeId = String(body.recipe_id ?? "").trim();
    const description = body.description ? String(body.description).slice(0, 400) : null;
    const paramsObj = body.params && typeof body.params === "object"
      ? (body.params as Record<string, unknown>) : {};
    if (!recipeId) {
      throw errors.invalidPayload({ reason: "recipe_id is required" });
    }
    const recipe = getRecipe(recipeId);
    if (!recipe) {
      throw errors.notFound("recipe");
    }
    // Validate params by attempting interpolation — surfaces missing/bad ones
    // up front instead of at first visitor fetch.
    try {
      interpolateQuery(recipe.query, paramsObj, recipe.params);
    } catch (err) {
      throw errors.invalidPayload({
        reason: "params don't satisfy recipe.params",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const db = getDb(c.env);
    const id = uuidv7();
    await db.insert(publicQueryPublications).values({
      id,
      userId: proj.userId,
      projectId: proj.id,
      recipeId,
      paramsJson: JSON.stringify(paramsObj),
      description,
      createdAt: Math.floor(Date.now() / 1000),
    });
    const baseUrl = new URL(c.req.url);
    return c.json({
      id,
      project_id: proj.id,
      recipe_id: recipeId,
      params: paramsObj,
      description,
      public_url: `${baseUrl.protocol}//${baseUrl.host}/v1/public/q/${id}`,
      next_action:
        "Embed `public_url?key=<agp_…>` in your dashboard. CORS is open. The agp_ key " +
        "lives in your local config (agentry_status surfaces it). Each publication is " +
        "fingerprinted to one (recipe_id, params) tuple — revoke with agentry_unpublish_query " +
        "if it's no longer needed.",
    });
  },
);

router.get(
  "/v1/projects/:project_id/public-queries",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    const proj = await requireProjectAccess(c, projectId);
    const db = getDb(c.env);
    const rows = await db
      .select()
      .from(publicQueryPublications)
      .where(
        and(
          eq(publicQueryPublications.projectId, proj.id),
          isNull(publicQueryPublications.revokedAt),
        ),
      )
      .orderBy(desc(publicQueryPublications.createdAt))
      .limit(200);
    const baseUrl = new URL(c.req.url);
    return c.json({
      project_id: proj.id,
      count: rows.length,
      publications: rows.map((r) => ({
        id: r.id,
        recipe_id: r.recipeId,
        params: safeJson(r.paramsJson),
        description: r.description,
        created_at: r.createdAt,
        last_used_at: r.lastUsedAt,
        public_url: `${baseUrl.protocol}//${baseUrl.host}/v1/public/q/${r.id}`,
      })),
    });
  },
);

router.delete(
  "/v1/projects/:project_id/public-queries/:publication_id",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    const publicationId = c.req.param("publication_id");
    const proj = await requireProjectAccess(c, projectId);
    const db = getDb(c.env);
    const rows = await db
      .select()
      .from(publicQueryPublications)
      .where(eq(publicQueryPublications.id, publicationId))
      .limit(1);
    const row = rows[0];
    if (!row || row.projectId !== proj.id) {
      throw errors.notFound("publication");
    }
    await db
      .update(publicQueryPublications)
      .set({ revokedAt: Math.floor(Date.now() / 1000) })
      .where(eq(publicQueryPublications.id, publicationId));
    return c.json({
      id: publicationId,
      revoked: true,
      next_action:
        "Embedded `public_url` will now 410 (Gone). Update or remove the dashboard reference.",
    });
  },
);

// ---------------------------------------------------------------------------
// Visitor-side execution — no auth header, agp_ key in query param.
// Wide-open CORS so any web app can hit it.
// ---------------------------------------------------------------------------

const publicRouter = new Hono<AppBindings>();
publicRouter.use("/v1/public/q/*", cors({ origin: "*", allowMethods: ["GET", "HEAD"] }));

publicRouter.get("/v1/public/q/:publication_id", async (c) => {
  const publicationId = c.req.param("publication_id");
  const rawKey = c.req.query("key");
  if (!rawKey || !rawKey.startsWith("agp_")) {
    throw errors.unauthorized("?key=<agp_…> required");
  }
  const db = getDb(c.env);

  // Look up the publication.
  const pubRows = await db
    .select()
    .from(publicQueryPublications)
    .where(eq(publicQueryPublications.id, publicationId))
    .limit(1);
  const pub = pubRows[0];
  if (!pub || pub.revokedAt) {
    // 410 Gone if revoked, 404 if never existed.
    return c.json({
      error: { code: "not_found", message: "publication not found or revoked" },
    }, pub?.revokedAt ? 410 : 404);
  }

  // Verify the agp_ key belongs to the same user as the publication.
  // Lookup is O(1) on the hash index.
  const keyHash = await sha256Hex(rawKey);
  const keyRows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  const key = keyRows[0];
  if (
    !key ||
    key.kind !== "public" ||
    key.revokedAt ||
    key.userId !== pub.userId
  ) {
    throw errors.unauthorized(
      "agp_ key invalid, revoked, wrong kind, or doesn't match this publication's owner",
    );
  }

  // Verify the project still exists (owner could have deleted it).
  const projRows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, pub.projectId))
    .limit(1);
  if (!projRows[0]) {
    return c.json({ error: { code: "not_found", message: "project deleted" } }, 410);
  }

  // Run the recipe. Per-team_id isolation is enforced by PostHog at the AST
  // level (the user's posthog_projects.team_id is used in the URL). No
  // additional filter injection needed.
  const recipe = getRecipe(pub.recipeId);
  if (!recipe) {
    throw errors.internal(`recipe ${pub.recipeId} no longer exists`);
  }
  if (!isPosthogConfigured(c.env)) {
    throw errors.internal("PostHog not configured on this deployment.");
  }
  const params = safeJson(pub.paramsJson) ?? {};
  const interpolated = interpolateQuery(recipe.query, params, recipe.params);
  const out = await runHogQl(c.env, pub.userId, interpolated);

  // Stamp last_used_at fire-and-forget.
  try {
    await db
      .update(publicQueryPublications)
      .set({ lastUsedAt: Math.floor(Date.now() / 1000) })
      .where(eq(publicQueryPublications.id, publicationId));
  } catch {
    /* non-fatal */
  }

  return c.json({
    publication_id: publicationId,
    recipe_id: pub.recipeId,
    description: pub.description,
    columns: out.columns,
    types: out.types,
    results: out.results,
  });
});

function safeJson<T = unknown>(s: string | null | undefined): T | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

export default router;
export { publicRouter };
