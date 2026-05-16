import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { errors, uuidv7 } from "@agentrysh/shared";
import { feedback } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import type { AppBindings } from "../env.js";
import type { User } from "@agentry/db/schema";

const router = new Hono<AppBindings>();

// POST /v1/feedback — agent files a feedback item.
// Auth: API key (so it's tied to a user). project_id is optional context.
router.post("/v1/feedback", requireApiKey(), async (c) => {
  const user = c.get("user") as User;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!message) {
    throw errors.invalidPayload({ reason: "message is required" });
  }

  const kindRaw = typeof b.kind === "string" ? b.kind : "other";
  const allowed = new Set(["missing_feature", "bug", "ux_friction", "other"]);
  const kind = (allowed.has(kindRaw) ? kindRaw : "other") as
    | "missing_feature" | "bug" | "ux_friction" | "other";

  const projectId = typeof b.project_id === "string" ? b.project_id : null;
  if (projectId) {
    // Verify the user owns the project — silently drop if they don't.
    await requireProjectAccess(c, projectId);
  }

  const id = uuidv7();
  const now = Math.floor(Date.now() / 1000);
  const db = getDb(c.env);
  await db.insert(feedback).values({
    id,
    userId: user.id,
    projectId,
    kind,
    message: message.slice(0, 4000),
    agentNote: typeof b.agent_note === "string" ? b.agent_note.slice(0, 4000) : null,
    toolName: typeof b.tool_name === "string" ? b.tool_name.slice(0, 200) : null,
    attemptCount: typeof b.attempt_count === "number" ? Math.floor(b.attempt_count) : null,
    claudeSessionId: typeof b.claude_session_id === "string"
      ? b.claude_session_id.slice(0, 200)
      : null,
    createdAt: now,
  });

  return c.json({
    id,
    received_at: now,
    next_action:
      "Feedback recorded. Tell the user: 'Thanks — I've logged that as feedback for the agentry team.' " +
      "Don't keep apologizing or revisit the same friction — file it once per distinct issue per session.",
  });
});

// GET /v1/feedback — list feedback the current user has filed.
// (Operator view for the project owner — there's no global admin path in v0.)
router.get("/v1/feedback", requireApiKey(), async (c) => {
  const user = c.get("user") as User;
  const limit = clamp(parseInt(c.req.query("limit") ?? "50", 10), 1, 500, 50);

  const resolvedRaw = c.req.query("resolved");
  const kindRaw = c.req.query("kind");
  const conditions = [eq(feedback.userId, user.id)];
  if (resolvedRaw === "true") conditions.push(eq(feedback.resolved, 1));
  else if (resolvedRaw === "false") conditions.push(eq(feedback.resolved, 0));
  if (kindRaw && ["missing_feature", "bug", "ux_friction", "other"].includes(kindRaw)) {
    conditions.push(eq(feedback.kind, kindRaw as
      "missing_feature" | "bug" | "ux_friction" | "other"));
  }

  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(feedback)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(feedback.createdAt))
    .limit(limit);

  return c.json({
    count: rows.length,
    feedback: rows.map(serializeFeedback),
    next_action:
      rows.length === 0
        ? "No feedback filed yet."
        : "Surface the most recent items as a short markdown table. Group by kind if useful.",
  });
});

function serializeFeedback(row: typeof feedback.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    project_id: row.projectId,
    kind: row.kind,
    message: row.message,
    agent_note: row.agentNote,
    tool_name: row.toolName,
    attempt_count: row.attemptCount,
    claude_session_id: row.claudeSessionId,
    created_at: row.createdAt,
    resolved: row.resolved === 1,
    resolution: row.resolution,
  };
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export default router;
