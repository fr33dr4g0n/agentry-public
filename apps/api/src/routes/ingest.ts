import { Hono, type Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import {
  IngestEventSchema,
  computeFingerprint,
  errors,
  parseDsn,
  sha256Hex,
  uuidv7,
} from "@agentry/shared";
import type { IngestEvent, StackFrame } from "@agentry/shared";
import { cases, events, projects, suppressionEntries } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { matchesPattern } from "./cases.js";
import { fireWebhooks } from "../webhooks.js";
import { incrementUsage } from "../usage.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

// Sentry-protocol-compatible store endpoint.
// Auth via:
//   - Authorization: Bearer <dsn>
//   - X-Sentry-Auth: ... sentry_key=<token> ...
//   - ?sentry_key=<token> query param
//
// `<token>` may be either the full DSN raw value (`agnt_<projectId>.<token>`)
// or just the token portion. We hash and look up against projects.dsnHash.

router.post("/store/:project_id/", async (c) => {
  return handleIngest(c);
});

// Some SDKs post without trailing slash.
router.post("/store/:project_id", async (c) => {
  return handleIngest(c);
});

async function handleIngest(c: Context<AppBindings>) {
  // Hard cap body size before parsing JSON. Default 256KB.
  const maxBytes = parsePositiveInt(c.env.MAX_BODY_BYTES, 262144);
  const cl = c.req.header("content-length");
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new (errors.invalidPayload({}).constructor as typeof import("@agentry/shared").AgentryError)({
        status: 413,
        code: "payload_too_large",
        message: `Body exceeds the ${maxBytes}-byte ingest limit.`,
        nextAction: "Strip large fields (full request body, breadcrumbs, base64 blobs) and retry.",
        details: { content_length: n, limit: maxBytes },
      });
    }
  }

  const projectId = c.req.param("project_id");
  if (!projectId) throw errors.notFound("project");

  const presented = extractAuthToken(c);
  if (!presented) throw errors.invalidDsn();

  const db = getDb(c.env);

  // Look up project. Hash the presented value AS-IS first (full DSN form).
  const projRows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const proj = projRows[0];
  if (!proj) throw errors.notFound("project");

  // Verify the presented token matches the project's stored DSN hash.
  // Accept either the full DSN string ("agnt_<projid>.<token>") or just the
  // token portion. We compute both possible hashes and compare.
  const asGivenHash = await sha256Hex(presented);
  let dsnOk = asGivenHash === proj.dsnHash;
  if (!dsnOk) {
    const reconstructed = `agnt_${projectId}.${presented}`;
    const reconstructedHash = await sha256Hex(reconstructed);
    dsnOk = reconstructedHash === proj.dsnHash;
  }
  if (!dsnOk) {
    // If they sent a full DSN, double-check the projectId matched (cosmetic).
    const parsed = parseDsn(presented);
    if (parsed && parsed.projectId !== projectId) {
      throw errors.invalidDsn();
    }
    throw errors.invalidDsn();
  }

  // Parse body — be defensive; bad payloads must not 5xx.
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  const parsed = IngestEventSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidPayload({ zod: parsed.error.flatten() });
  }
  const ev: IngestEvent = parsed.data;

  // Extract error_type / message defensively.
  const exc = ev.exception?.values?.[0];
  const errorType = (exc?.type ?? "Error").toString().slice(0, 200) || "Error";
  const messageRaw =
    (typeof exc?.value === "string" && exc.value) ||
    (typeof ev.message === "string" && ev.message) ||
    (ev.message && typeof ev.message === "object" &&
      ((ev.message as { formatted?: string }).formatted ??
        (ev.message as { message?: string }).message)) ||
    "";
  const message = (messageRaw || "").toString().slice(0, 4000);

  const frames: StackFrame[] =
    (exc?.stacktrace?.frames as StackFrame[] | undefined) ?? [];

  const fingerprint = await computeFingerprint({
    errorType,
    message,
    frames,
  });

  const deploySha =
    (typeof ev.deploy_sha === "string" && ev.deploy_sha) ||
    (typeof ev.release === "string" && ev.release) ||
    null;
  const environment =
    typeof ev.environment === "string" ? ev.environment : null;

  // Extract user.id / user.email from the standard Sentry-shape `user` object.
  const userObj = (ev.user ?? {}) as { id?: unknown; email?: unknown };
  const userId =
    typeof userObj.id === "string" || typeof userObj.id === "number"
      ? String(userObj.id).slice(0, 200)
      : null;
  const userEmail =
    typeof userObj.email === "string" ? userObj.email.slice(0, 320) : null;

  // Suppression check. Cap the scan so a user can't slow their own ingest.
  const maxSuppressions = parsePositiveInt(c.env.MAX_SUPPRESSIONS_PER_PROJECT, 200);
  const suppressions = await db
    .select()
    .from(suppressionEntries)
    .where(eq(suppressionEntries.projectId, projectId))
    .limit(maxSuppressions);

  const matched = suppressions.find((s) =>
    matchesPattern(s.fingerprintPattern, fingerprint),
  );

  if (matched && matched.action === "auto_ignore") {
    return c.json(
      {
        suppressed: true,
        reason: "auto_ignore",
        next_action:
          "This fingerprint matches a suppression rule. No case was created.",
      },
      202,
    );
  }

  // Upsert case.
  const now = Math.floor(Date.now() / 1000);
  const eventId = uuidv7();

  // Insert event row.
  await db.insert(events).values({
    id: eventId,
    projectId,
    fingerprint,
    errorType,
    message,
    stack: JSON.stringify(frames),
    deploySha,
    environment,
    userId,
    userEmail,
    breadcrumbsJson: ev.breadcrumbs ? JSON.stringify(ev.breadcrumbs) : null,
    requestJson: ev.request ? JSON.stringify(ev.request) : null,
    tagsJson: ev.tags ? JSON.stringify(ev.tags) : null,
    extraJson: ev.extra ? JSON.stringify(ev.extra) : null,
    receivedAt: now,
  });

  // Find existing case.
  const existing = await db
    .select()
    .from(cases)
    .where(and(eq(cases.projectId, projectId), eq(cases.fingerprint, fingerprint)))
    .limit(1);

  let caseId: string;
  let isNewCase = false;
  if (existing[0]) {
    caseId = existing[0].id;
    await db
      .update(cases)
      .set({
        eventCount: sql`${cases.eventCount} + 1`,
        lastSeenAt: now,
        lastDeploySha: deploySha ?? existing[0].lastDeploySha,
        message,
      })
      .where(eq(cases.id, caseId));
  } else {
    isNewCase = true;
    caseId = uuidv7();
    const initialStatus =
      matched && matched.action === "auto_resolve" ? "resolved" : "open";
    const initialSummary =
      matched && matched.action === "auto_resolve"
        ? matched.reason ?? "Auto-resolved by suppression rule."
        : null;

    await db.insert(cases).values({
      id: caseId,
      projectId,
      fingerprint,
      errorType,
      message,
      status: initialStatus,
      eventCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      lastDeploySha: deploySha,
      agentSummary: initialSummary,
      prUrl: null,
    });
  }

  // Bump usage counter (best-effort, never blocks the request).
  await incrementUsage(c.env, projectId, "errors");

  // Fire webhooks for case.created (new fingerprints only). waitUntil keeps
  // delivery off the request critical path.
  if (isNewCase) {
    const waitUntil = (p: Promise<unknown>) =>
      c.executionCtx?.waitUntil ? c.executionCtx.waitUntil(p) : void p.catch(() => {});
    await fireWebhooks(
      c.env,
      projectId,
      "case.created",
      {
        case_id: caseId,
        fingerprint,
        error_type: errorType,
        message,
        last_deploy_sha: deploySha,
        first_seen_at: now,
      },
      { waitUntil },
    );
  }

  return c.json(
    {
      event_id: eventId,
      case_id: caseId,
      suppressed: false,
      next_action:
        "Event accepted. The user's Claude Code can call GET /v1/cases/" +
        caseId +
        " to investigate.",
    },
    200,
  );
}

function extractAuthToken(c: Context<AppBindings>): string | null {
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

function parsePositiveInt(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export default router;
