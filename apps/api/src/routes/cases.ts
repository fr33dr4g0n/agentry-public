import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import {
  RecordAgentRunRequestSchema,
  UpdateCaseRequestSchema,
  errors,
  uuidv7,
} from "@agentry/shared";
import type { CaseStatus, StackFrame } from "@agentry/shared";
import {
  agentRuns,
  cases,
  events,
  suppressionEntries,
} from "@agentry/db/schema";
import { getDb } from "../db.js";
import {
  requireApiKey,
  requireCaseAccess,
  requireProjectAccess,
} from "../middleware.js";
import type { AppBindings } from "../env.js";
import { recentDeploysFor } from "./deploys.js";
import { fireWebhooks } from "../webhooks.js";

// Cases that hang off /v1/projects/:project_id
// IMPORTANT: this sub-app is mounted at /v1, so the middleware path here is
// relative to that. Scoping to /projects/* ensures requests to siblings
// like /v1/store/* don't hit this auth middleware.
export const projectScopedCases = new Hono<AppBindings>();
projectScopedCases.use("/projects/*", requireApiKey());

projectScopedCases.get("/projects/:project_id/cases", async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);

  const statusParam = c.req.query("status");
  const limitParam = parseInt(c.req.query("limit") ?? "50", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.max(1, Math.min(200, limitParam))
    : 50;

  const allowed: ReadonlyArray<CaseStatus> = [
    "open",
    "investigating",
    "resolved",
    "spurious",
    "ignored",
  ];

  let status: CaseStatus | undefined = "open";
  if (statusParam !== undefined && statusParam !== "") {
    if (statusParam === "all") {
      status = undefined;
    } else if ((allowed as readonly string[]).includes(statusParam)) {
      status = statusParam as CaseStatus;
    } else {
      throw errors.invalidPayload({
        reason: `unknown status filter "${statusParam}"`,
        allowed: [...allowed, "all"],
      });
    }
  }

  const db = getDb(c.env);
  const where = status
    ? and(eq(cases.projectId, projectId), eq(cases.status, status))
    : eq(cases.projectId, projectId);

  const rows = await db
    .select()
    .from(cases)
    .where(where)
    .orderBy(desc(cases.lastSeenAt))
    .limit(limit);

  return c.json({
    cases: rows.map((r) => ({
      id: r.id,
      project_id: r.projectId,
      fingerprint: r.fingerprint,
      error_type: r.errorType,
      message: r.message,
      status: r.status,
      event_count: r.eventCount,
      first_seen_at: r.firstSeenAt,
      last_seen_at: r.lastSeenAt,
      last_deploy_sha: r.lastDeploySha,
      agent_summary: r.agentSummary,
      pr_url: r.prUrl,
    })),
    next_action:
      "For each case worth investigating, call GET /v1/cases/:id to read recent_events and suppression_hints, " +
      "then PATCH /v1/cases/:id with status=resolved or spurious once handled.",
  });
});

// Cases scoped directly by case id
export const caseRouter = new Hono<AppBindings>();
caseRouter.use("*", requireApiKey());

caseRouter.get("/:case_id", async (c) => {
  const caseId = c.req.param("case_id");
  const { case: row, project } = await requireCaseAccess(c, caseId);

  const db = getDb(c.env);

  const recentEvents = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.projectId, row.projectId),
        eq(events.fingerprint, row.fingerprint),
      ),
    )
    .orderBy(desc(events.receivedAt))
    .limit(5);

  const allSuppressions = await db
    .select()
    .from(suppressionEntries)
    .where(eq(suppressionEntries.projectId, row.projectId));

  const matchingSuppressions = allSuppressions.filter((s) =>
    matchesPattern(s.fingerprintPattern, row.fingerprint),
  );

  // Surface the last 5 deploys so the agent can attribute regressions.
  const recentDeploys = await recentDeploysFor(c, row.projectId, 5);

  return c.json({
    id: row.id,
    project_id: row.projectId,
    fingerprint: row.fingerprint,
    error_type: row.errorType,
    message: row.message,
    status: row.status,
    event_count: row.eventCount,
    first_seen_at: row.firstSeenAt,
    last_seen_at: row.lastSeenAt,
    last_deploy_sha: row.lastDeploySha,
    agent_summary: row.agentSummary,
    pr_url: row.prUrl,
    local_path: project.localPath,
    recent_events: recentEvents.map((e) => ({
      id: e.id,
      received_at: e.receivedAt,
      deploy_sha: e.deploySha,
      environment: e.environment,
      message: e.message,
      stack: safeJsonArray<StackFrame>(e.stack),
    })),
    suppression_hints: matchingSuppressions.map((s) => ({
      id: s.id,
      action: s.action,
      pattern: s.fingerprintPattern,
      hint_text: s.hintText,
      reason: s.reason,
    })),
    recent_deploys: recentDeploys,
    next_actions: [
      "Read recent_events to find the offending code path and the deploy_sha that introduced it.",
      "Cross-reference last_deploy_sha with recent_deploys[] to identify the suspect deploy.",
      "git log + git blame from local_path to find when this regressed.",
      "Open a PR fixing it; if uncertain, call PATCH /v1/cases/:id with status=spurious or resolved and a summary.",
      "If this looks like recurring noise, POST /v1/projects/:project_id/suppressions to silence future occurrences.",
    ],
  });
});

caseRouter.patch("/:case_id", async (c) => {
  const caseId = c.req.param("case_id");
  await requireCaseAccess(c, caseId);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  const parsed = UpdateCaseRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidPayload({ zod: parsed.error.flatten() });
  }

  const updates: Partial<{
    status: CaseStatus;
    agentSummary: string;
    prUrl: string;
  }> = {};
  if (parsed.data.status) updates.status = parsed.data.status;
  if (parsed.data.agent_summary !== undefined)
    updates.agentSummary = parsed.data.agent_summary;
  if (parsed.data.pr_url !== undefined) updates.prUrl = parsed.data.pr_url;

  if (Object.keys(updates).length === 0) {
    throw errors.invalidPayload({ reason: "no fields provided to update" });
  }

  const db = getDb(c.env);
  // Capture pre-state to detect transitions worth firing webhooks for.
  const beforeRows = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  const before = beforeRows[0];
  await db.update(cases).set(updates).where(eq(cases.id, caseId));

  const after = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  const row = after[0];
  if (!row) throw errors.notFound("case");

  // Fire case.resolved if the status just transitioned into "resolved".
  if (before && before.status !== "resolved" && row.status === "resolved") {
    const waitUntil = (p: Promise<unknown>) =>
      c.executionCtx?.waitUntil ? c.executionCtx.waitUntil(p) : void p.catch(() => {});
    await fireWebhooks(
      c.env,
      row.projectId,
      "case.resolved",
      {
        case_id: row.id,
        fingerprint: row.fingerprint,
        error_type: row.errorType,
        message: row.message,
        agent_summary: row.agentSummary,
        pr_url: row.prUrl,
        last_deploy_sha: row.lastDeploySha,
      },
      { waitUntil },
    );
  }

  return c.json({
    id: row.id,
    status: row.status,
    agent_summary: row.agentSummary,
    pr_url: row.prUrl,
    next_action:
      row.status === "resolved" || row.status === "spurious"
        ? "Case closed. Consider POST /v1/projects/:project_id/suppressions if the same fingerprint is likely to recur."
        : "Continue investigating; PATCH again with status=resolved or spurious when finished.",
  });
});

caseRouter.post("/:case_id/runs", async (c) => {
  const caseId = c.req.param("case_id");
  await requireCaseAccess(c, caseId);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  const parsed = RecordAgentRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidPayload({ zod: parsed.error.flatten() });
  }

  const db = getDb(c.env);
  const id = uuidv7();
  const now = Math.floor(Date.now() / 1000);
  await db.insert(agentRuns).values({
    id,
    caseId,
    startedAt: now,
    finishedAt: now,
    status: parsed.data.status,
    summaryMd: parsed.data.summary_md ?? null,
    prUrl: parsed.data.pr_url ?? null,
    action: parsed.data.status,
  });

  return c.json({
    id,
    case_id: caseId,
    status: parsed.data.status,
    next_action:
      "Run recorded. If you opened a PR, also PATCH /v1/cases/:case_id with status=resolved and pr_url.",
  });
});

function matchesPattern(pattern: string, fingerprint: string): boolean {
  if (!pattern) return false;
  // v0: substring match only. Regex was attractive but exposes ReDoS via user-supplied
  // patterns, since this runs on every ingest event for a project. Re-introduce when
  // we can run patterns under a hard timeout (e.g. RE2 in Workers, or a syntax-restricted
  // glob).
  return fingerprint.includes(pattern);
}

function safeJsonArray<T>(s: string | null | undefined): T[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export { matchesPattern };
