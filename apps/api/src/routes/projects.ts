import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import {
  CreateProjectRequestSchema,
  errors,
  mintDsn,
  uuidv7,
} from "@agentrysh/shared";
import { projects } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

router.use("*", requireApiKey());

router.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  const parsed = CreateProjectRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidPayload({ zod: parsed.error.flatten() });
  }
  const { name, repo_url, default_branch, local_path } = parsed.data;

  const user = c.get("user");
  const db = getDb(c.env);

  const projectId = uuidv7();
  const dsn = await mintDsn(projectId);

  await db.insert(projects).values({
    id: projectId,
    userId: user.id,
    name,
    repoUrl: repo_url ?? null,
    defaultBranch: default_branch ?? "main",
    localPath: local_path ?? null,
    dsnPrefix: dsn.prefix,
    dsnHash: dsn.hash,
    createdAt: Math.floor(Date.now() / 1000),
  });

  const reqUrl = new URL(c.req.url);
  const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
  return c.json({
    id: projectId,
    name,
    dsn: dsn.raw,
    logs_url: `${baseUrl}/v1/logs/${projectId}/`,
    analytics_url: `${baseUrl}/v1/analytics/${projectId}/`,
    deploys_url: `${baseUrl}/v1/deploys/${projectId}/`,
    install_snippet:
      "// Save AGENTRY_DSN to your env. Then any-language fetch:\n" +
      `// fetch('${baseUrl}/v1/logs/${projectId}/', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.AGENTRY_DSN, 'content-type': 'application/json', 'user-agent': 'agentry-app/1.0' }, body: JSON.stringify(payload) })`,
    next_action:
      "Save this DSN as AGENTRY_DSN env var in your app. POST logs to logs_url, analytics to analytics_url, deploys to deploys_url — all with header 'authorization: Bearer <DSN>'. " +
      "ALWAYS set a custom User-Agent header on direct HTTP calls — Cloudflare's Browser Integrity " +
      "Check returns 403 (CF error 1010) for default urllib/curl UAs. " +
      "DO NOT pass this DSN to sentry_sdk.init() / @sentry/* — agentry's DSN uses UUID project ids which " +
      "Sentry SDKs reject (BadDsn). Use the helper from agentry_install_guide instead. " +
      "The DSN won't be shown again — store it now.",
  });
});

router.get("/", async (c) => {
  const user = c.get("user");
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      localPath: projects.localPath,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(eq(projects.userId, user.id))
    .orderBy(desc(projects.createdAt));

  return c.json({
    projects: rows.map((r) => ({
      id: r.id,
      name: r.name,
      repo_url: r.repoUrl,
      default_branch: r.defaultBranch,
      local_path: r.localPath,
      created_at: r.createdAt,
    })),
    next_action:
      "Use GET /v1/projects/:id for detail, or POST /v1/projects to create another. " +
      "DSNs are not returned here — they are only shown at creation time.",
  });
});

router.get("/:id", async (c) => {
  const id = c.req.param("id");
  const proj = await requireProjectAccess(c, id);
  return c.json({
    id: proj.id,
    name: proj.name,
    repo_url: proj.repoUrl,
    default_branch: proj.defaultBranch,
    local_path: proj.localPath,
    created_at: proj.createdAt,
    next_action:
      "Call GET /v1/projects/:id/cases?status=open to see open cases for this project.",
  });
});

export default router;
