// POST /v1/sourcemaps/{project_id}/  — upload a single sourcemap blob
// GET  /v1/sourcemaps/{project_id}/  — list uploaded sourcemaps for a project
// DELETE /v1/sourcemaps/{project_id}/  — clean up old release(s)
//
// Auth: Bearer DSN (the same key your app uses for ingest). Sourcemap uploads
// don't need user-scoped auth — they're keyed by project, and the DSN already
// authenticates the project. Pin to release_id (git SHA) so multiple deploys
// can coexist; old releases can be deleted out-of-band.

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { errors, parseDsn, uuidv7 } from "@agentrysh/shared";
import { sourcemaps, projects } from "@agentry/db/schema";
import { getDb } from "../db.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

// Same DSN auth helper used by /v1/log/ + /v1/track/. Inline here to avoid
// pulling in the larger middleware that requires per-user api keys.
async function requireDsnForProject(
  c: Parameters<Parameters<typeof router.get>[1]>[0],
  projectId: string,
): Promise<void> {
  const auth = c.req.header("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw errors.unauthorized("Bearer DSN required.");
  const dsn = m[1].trim();
  const parsed = parseDsn(dsn);
  if (!parsed) throw errors.invalidDsn();
  if (parsed.projectId !== projectId) {
    throw errors.forbidden("DSN does not match this project.");
  }
  const db = getDb(c.env);
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!row) throw errors.notFound("project");
  if (row.dsnPrefix !== parsed.prefix || row.dsnHash !== parsed.hash) {
    throw errors.unauthorized("DSN does not match project secret.");
  }
}

router.post("/v1/sourcemaps/:project_id/", (c) => postSourcemap(c));
router.post("/v1/sourcemaps/:project_id", (c) => postSourcemap(c));
async function postSourcemap(c: Parameters<Parameters<typeof router.post>[1]>[0]) {
  const projectId = c.req.param("project_id");
  await requireDsnForProject(c, projectId);

  if (!c.env.SOURCEMAPS) {
    throw errors.internal("Sourcemap storage is not configured on this deployment.");
  }

  // Required query params. We use the body for the sourcemap JSON itself,
  // so metadata travels in the URL.
  const releaseId = (c.req.query("release_id") ?? "default").trim();
  const sourceUrlRaw = c.req.query("source_url");
  if (!sourceUrlRaw) {
    throw errors.invalidPayload({
      reason: "source_url query param required (e.g. source_url=/static/chunks/abc.js)",
    });
  }
  // Normalize: if a full URL is given, store the pathname. That's what
  // translate-time lookup will compare against.
  let sourceUrl: string;
  try {
    sourceUrl = new URL(sourceUrlRaw).pathname;
  } catch {
    sourceUrl = sourceUrlRaw.replace(/[?#].*$/, "");
  }

  // Body must be the raw sourcemap JSON. Cap size to avoid abuse.
  const maxBytes = Number(c.env.MAX_SOURCEMAP_BYTES ?? "8388608");
  const lenHeader = c.req.header("content-length");
  if (lenHeader && Number(lenHeader) > maxBytes) {
    throw errors.invalidPayload({ reason: "body too large", limit_bytes: maxBytes });
  }
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw errors.invalidPayload({ reason: "body too large", limit_bytes: maxBytes });
  }
  if (buf.byteLength === 0) {
    throw errors.invalidPayload({ reason: "empty body — POST the sourcemap JSON as the body" });
  }
  // Validate it parses as JSON. We don't validate the full source-map schema
  // here (that's enforced at translate-time when TraceMap is instantiated).
  try {
    JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw errors.invalidPayload({ reason: "body must be valid JSON (the sourcemap)" });
  }

  // R2 key shape: <project_id>/<release_id>/<source_url-encoded>
  const safeSource = sourceUrl.replace(/^\//, "").replace(/\//g, "_");
  const r2Key = `${projectId}/${releaseId}/${safeSource}`;
  await c.env.SOURCEMAPS!.put(r2Key, buf, {
    httpMetadata: { contentType: "application/json" },
  });

  // Upsert the index row. Drizzle's libSQL driver doesn't expose ON CONFLICT
  // ergonomically across all paths, so we do a delete-then-insert in a
  // batch-equivalent pair. The unique index on (project_id, release_id,
  // source_url) protects against races at the DB level.
  const db = getDb(c.env);
  await db
    .delete(sourcemaps)
    .where(
      and(
        eq(sourcemaps.projectId, projectId),
        eq(sourcemaps.releaseId, releaseId),
        eq(sourcemaps.sourceUrl, sourceUrl),
      ),
    );
  const id = uuidv7();
  await db.insert(sourcemaps).values({
    id,
    projectId,
    releaseId,
    sourceUrl,
    r2Key,
    sizeBytes: buf.byteLength,
    uploadedAt: Math.floor(Date.now() / 1000),
  });

  return c.json({
    id,
    project_id: projectId,
    release_id: releaseId,
    source_url: sourceUrl,
    size_bytes: buf.byteLength,
    next_action:
      "Sourcemap stored. agentry will translate matching frames server-side on " +
      "GET /v1/cases/:id reads. Upload one map per minified bundle; the release_id " +
      "should match your deploy SHA so old releases don't conflict.",
  });
}

router.get("/v1/sourcemaps/:project_id/", (c) => listSourcemaps(c));
router.get("/v1/sourcemaps/:project_id", (c) => listSourcemaps(c));
async function listSourcemaps(c: Parameters<Parameters<typeof router.get>[1]>[0]) {
  const projectId = c.req.param("project_id");
  await requireDsnForProject(c, projectId);

  const releaseId = c.req.query("release_id");
  const db = getDb(c.env);
  const where = releaseId
    ? and(eq(sourcemaps.projectId, projectId), eq(sourcemaps.releaseId, releaseId))
    : eq(sourcemaps.projectId, projectId);
  const rows = await db
    .select()
    .from(sourcemaps)
    .where(where)
    .orderBy(desc(sourcemaps.uploadedAt))
    .limit(500);
  return c.json({
    project_id: projectId,
    count: rows.length,
    sourcemaps: rows.map((r) => ({
      id: r.id,
      release_id: r.releaseId,
      source_url: r.sourceUrl,
      size_bytes: r.sizeBytes,
      uploaded_at: r.uploadedAt,
    })),
  });
}

router.delete("/v1/sourcemaps/:project_id/", (c) => deleteSourcemaps(c));
router.delete("/v1/sourcemaps/:project_id", (c) => deleteSourcemaps(c));
async function deleteSourcemaps(c: Parameters<Parameters<typeof router.delete>[1]>[0]) {
  const projectId = c.req.param("project_id");
  await requireDsnForProject(c, projectId);

  if (!c.env.SOURCEMAPS) {
    throw errors.internal("Sourcemap storage is not configured on this deployment.");
  }

  const releaseId = c.req.query("release_id");
  if (!releaseId) {
    throw errors.invalidPayload({
      reason: "release_id query param required — refuses to delete all sourcemaps in one call.",
    });
  }

  const db = getDb(c.env);
  const rows = await db
    .select({ id: sourcemaps.id, r2Key: sourcemaps.r2Key })
    .from(sourcemaps)
    .where(
      and(eq(sourcemaps.projectId, projectId), eq(sourcemaps.releaseId, releaseId)),
    );
  for (const r of rows) {
    try {
      await c.env.SOURCEMAPS!.delete(r.r2Key);
    } catch {
      // R2 delete is best-effort — if the object's already gone, the DB
      // row is what matters for lookups.
    }
  }
  await db
    .delete(sourcemaps)
    .where(
      and(eq(sourcemaps.projectId, projectId), eq(sourcemaps.releaseId, releaseId)),
    );

  return c.json({
    project_id: projectId,
    release_id: releaseId,
    deleted: rows.length,
  });
}

export default router;
