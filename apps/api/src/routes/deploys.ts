import { Hono } from "hono";
import { desc, eq, lte, gte, and } from "drizzle-orm";
import { errors, parseDsn, sha256Hex, uuidv7 } from "@agentry/shared";
import { deploys, projects } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import { fireWebhooks } from "../webhooks.js";
import { incrementUsage } from "../usage.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// Deploy events
//
// SDK ingests via POST /v1/deploys/:project_id/ with DSN auth (same as ingest).
// Agents read via GET /v1/projects/:project_id/deploys (api-key auth).
// ---------------------------------------------------------------------------

router.post("/v1/deploys/:project_id/", async (c) => {
  return await handleDeployIngest(c);
});
router.post("/v1/deploys/:project_id", async (c) => {
  return await handleDeployIngest(c);
});

router.get("/v1/projects/:project_id/deploys", requireApiKey(), async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);

  const limit = clamp(parseInt(c.req.query("limit") ?? "20", 10), 1, 200, 20);
  const since = parseInt(c.req.query("since") ?? "0", 10);

  const db = getDb(c.env);
  const where = since
    ? and(eq(deploys.projectId, projectId), gte(deploys.receivedAt, since))
    : eq(deploys.projectId, projectId);

  const rows = await db
    .select()
    .from(deploys)
    .where(where)
    .orderBy(desc(deploys.receivedAt))
    .limit(limit);

  return c.json({
    deploys: rows.map(serializeDeploy),
    next_action:
      rows.length === 0
        ? "No deploys recorded yet. Have CI call POST /v1/deploys/:project_id/ on every successful deploy, or use agentry_record_deploy from the MCP."
        : "Match the most recent deploy.received_at to a case's last_seen_at to attribute regressions.",
  });
});

async function handleDeployIngest(c: Parameters<typeof router.post>[1] extends infer _ ? import("hono").Context<AppBindings> : never) {
  const projectId = c.req.param("project_id");
  if (!projectId) throw errors.notFound("project");

  // DSN auth (Bearer or X-Sentry-Auth, same as /v1/store).
  const presented = extractAuthToken(c);
  if (!presented) throw errors.invalidDsn();

  const db = getDb(c.env);
  const projRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const proj = projRows[0];
  if (!proj) throw errors.notFound("project");

  const asGivenHash = await sha256Hex(presented);
  let dsnOk = asGivenHash === proj.dsnHash;
  if (!dsnOk) {
    const reconstructed = `agnt_${projectId}.${presented}`;
    const reconstructedHash = await sha256Hex(reconstructed);
    dsnOk = reconstructedHash === proj.dsnHash;
  }
  if (!dsnOk) {
    const parsedDsn = parseDsn(presented);
    if (parsedDsn && parsedDsn.projectId !== projectId) throw errors.invalidDsn();
    throw errors.invalidDsn();
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }

  const b = body as Record<string, unknown> | null;
  const sha = typeof b?.sha === "string" ? b.sha.slice(0, 200) : null;
  if (!sha) {
    throw errors.invalidPayload({ reason: "sha is required" });
  }

  const id = uuidv7();
  const now = Math.floor(Date.now() / 1000);
  const branch = typeof b.branch === "string" ? b.branch.slice(0, 200) : null;
  const environment = typeof b.environment === "string" ? b.environment.slice(0, 100) : null;
  const message = typeof b.message === "string" ? b.message.slice(0, 4000) : null;
  const url = typeof b.url === "string" ? b.url.slice(0, 500) : null;
  const actor = typeof b.actor === "string" ? b.actor.slice(0, 200) : null;
  await db.insert(deploys).values({
    id, projectId, sha, branch, environment, message, url, actor, receivedAt: now,
  });
  await incrementUsage(c.env, projectId, "deploys");

  const waitUntil = (p: Promise<unknown>) =>
    c.executionCtx?.waitUntil ? c.executionCtx.waitUntil(p) : void p.catch(() => {});
  await fireWebhooks(
    c.env,
    projectId,
    "deploy.recorded",
    { deploy_id: id, sha, branch, environment, message, url, actor, received_at: now },
    { waitUntil },
  );

  return c.json({
    id,
    project_id: projectId,
    sha,
    received_at: now,
    next_action:
      "Deploy recorded. Future cases with last_seen_at after this timestamp will surface this deploy in their context.",
  });
}

function extractAuthToken(c: import("hono").Context<AppBindings>): string | null {
  const auth = c.req.header("authorization") ?? c.req.header("Authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }
  const xs = c.req.header("x-sentry-auth") ?? c.req.header("X-Sentry-Auth");
  if (xs) {
    const m = xs.match(/sentry_key=([^,\s]+)/i);
    if (m && m[1]) return m[1].trim();
  }
  const q = c.req.query("sentry_key");
  if (q) return q;
  return null;
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function serializeDeploy(d: import("@agentry/db/schema").Deploy) {
  return {
    id: d.id,
    sha: d.sha,
    branch: d.branch,
    environment: d.environment,
    message: d.message,
    url: d.url,
    actor: d.actor,
    received_at: d.receivedAt,
  };
}

// Helper exported for cases.ts to look up nearby deploys.
export async function recentDeploysFor(
  c: import("hono").Context<AppBindings>,
  projectId: string,
  limit: number = 5,
) {
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(deploys)
    .where(eq(deploys.projectId, projectId))
    .orderBy(desc(deploys.receivedAt))
    .limit(limit);
  return rows.map(serializeDeploy);
}

// Suppress lint on unused import now (kept for future filtering).
void lte;

export default router;
