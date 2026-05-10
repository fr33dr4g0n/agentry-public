import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import {
  CreateProjectRequestSchema,
  dsnToSentryUrl,
  errors,
  mintDsn,
  uuidv7,
} from "@agentry/shared";
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

  // URL-form DSN for non-JS callers using existing Sentry SDKs (sentry-python,
  // sentry-ruby, sentry-go, etc.). The host is derived from the request URL so
  // the customer points their existing Sentry SDK at this exact deployment.
  const reqUrl = new URL(c.req.url);
  const sentryDsnUrl = dsnToSentryUrl({
    dsnRaw: dsn.raw,
    host: reqUrl.host,
    protocol: reqUrl.protocol.replace(":", ""),
  });

  return c.json({
    id: projectId,
    name,
    dsn: dsn.raw,
    sentry_dsn_url: sentryDsnUrl,
    ingest_url: `${reqUrl.protocol}//${reqUrl.host}/v1/log/${projectId}/`,
    install_snippet:
      "import { agentry } from '@agentry/node'; " +
      "agentry.init({ dsn: '" +
      dsn.raw +
      "', deploySha: process.env.GIT_SHA });",
    next_action:
      "Save this DSN as AGENTRY_DSN env var in your app. JS apps: call agentry.init(). " +
      "Other languages: POST any JSON to ingest_url with header 'authorization: Bearer <DSN>'. " +
      "Existing Sentry SDKs: set SENTRY_DSN to sentry_dsn_url. " +
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
