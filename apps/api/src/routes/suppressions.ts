import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import {
  RecordSuppressionRequestSchema,
  errors,
  uuidv7,
} from "@agentry/shared";
import { suppressionEntries } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();
// Mounted at /v1; scope auth to /projects/* so it doesn't intercept ingest etc.
router.use("/projects/*", requireApiKey());

router.post("/projects/:project_id/suppressions", async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  const parsed = RecordSuppressionRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidPayload({ zod: parsed.error.flatten() });
  }

  const db = getDb(c.env);
  const id = uuidv7();
  await db.insert(suppressionEntries).values({
    id,
    projectId,
    fingerprintPattern: parsed.data.fingerprint_pattern,
    action: parsed.data.action,
    reason: parsed.data.reason ?? null,
    hintText: parsed.data.hint_text ?? null,
    createdAt: Math.floor(Date.now() / 1000),
  });

  return c.json({
    id,
    project_id: projectId,
    fingerprint_pattern: parsed.data.fingerprint_pattern,
    action: parsed.data.action,
    next_action:
      parsed.data.action === "auto_ignore"
        ? "Future events matching this pattern will be silently dropped."
        : parsed.data.action === "auto_resolve"
        ? "Future cases matching this pattern will be auto-resolved without agent dispatch."
        : "Future cases matching this pattern will include hint_text for the agent.",
  });
});

router.get("/projects/:project_id/suppressions", async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);

  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(suppressionEntries)
    .where(eq(suppressionEntries.projectId, projectId))
    .orderBy(desc(suppressionEntries.createdAt));

  return c.json({
    suppressions: rows.map((r) => ({
      id: r.id,
      fingerprint_pattern: r.fingerprintPattern,
      action: r.action,
      reason: r.reason,
      hint_text: r.hintText,
      created_at: r.createdAt,
    })),
  });
});

export default router;
