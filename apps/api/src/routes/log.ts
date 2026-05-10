// Unified /v1/log/:project_id/ endpoint. The "just like console.log" entry point.
//
// Accepts any JSON body. Auto-detects whether it's an error, deploy, analytics
// event, or generic log line, and dispatches internally. Customer's mental model:
//
//   agentry.log({ event: "checkout_completed", amount: 19.99 })
//   agentry.log(new Error("kaboom"))            // SDK serializes
//   agentry.log({ sha: "deadbeef", branch: "main" })
//   agentry.log({ anything: "we figure it out" })
//
// The agentry server figures out what bucket each one belongs to.

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
import type { StackFrame } from "@agentry/shared";
import { cases, deploys, events, projects, suppressionEntries } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { matchesPattern } from "./cases.js";
import { forwardCapture, isPosthogConfigured } from "../posthog.js";
import { fireWebhooks } from "../webhooks.js";
import { incrementUsage } from "../usage.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

router.post("/v1/log/:project_id/", (c) => handleLog(c));
router.post("/v1/log/:project_id", (c) => handleLog(c));

async function handleLog(c: Context<AppBindings>) {
  // Body-size cap (same as typed endpoints).
  const maxBytes = parsePositiveInt(c.env.MAX_BODY_BYTES, 262144);
  const cl = c.req.header("content-length");
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) {
      return c.json(
        {
          error: {
            code: "payload_too_large",
            message: `Body exceeds the ${maxBytes}-byte ingest limit.`,
            next_action: "Strip large fields and retry.",
          },
        },
        413,
      );
    }
  }

  const projectId = c.req.param("project_id");
  if (!projectId) throw errors.notFound("project");

  // DSN auth (same as typed endpoints).
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

  const detected = detectSignalKind(body);

  if (detected === "error") {
    return await handleErrorSignal(c, projectId, body);
  }
  if (detected === "deploy") {
    return await handleDeploySignal(c, projectId, body);
  }
  if (detected === "event") {
    return await handleEventSignal(c, projectId, proj.userId, body);
  }
  // "log" — generic. Funnel into analytics with event_name="log" so it lands somewhere queryable.
  return await handleEventSignal(c, projectId, proj.userId, {
    ...(body as Record<string, unknown>),
    event: "log",
  });
}

// ---------------------------------------------------------------------------
// Signal detection
// ---------------------------------------------------------------------------

export type SignalKind = "error" | "deploy" | "event" | "log";

export function detectSignalKind(body: unknown): SignalKind {
  if (!body || typeof body !== "object") return "log";
  const b = body as Record<string, unknown>;

  // Explicit kind wins.
  if (typeof b.kind === "string") {
    const k = (b.kind as string).toLowerCase();
    if (k === "error" || k === "deploy" || k === "event" || k === "log") return k as SignalKind;
  }

  // Errors: anything that smells like an exception or has a stack trace.
  if (b.exception || typeof b.stack === "string" || b.error_type || b.exception_type) {
    return "error";
  }
  // An Error instance serialized to JSON typically has `name` + `message` + `stack`.
  if (
    typeof b.name === "string" &&
    typeof b.message === "string" &&
    typeof b.stack === "string"
  ) {
    return "error";
  }

  // Deploys: has `sha` (and not also an `event` name suggesting analytics).
  if (typeof b.sha === "string" && !b.event) return "deploy";

  // Analytics: has `event` (the action name).
  if (typeof b.event === "string") return "event";

  return "log";
}

// ---------------------------------------------------------------------------
// Internal dispatchers (mirror logic from typed routes; kept inline for v0)
// ---------------------------------------------------------------------------

async function handleErrorSignal(
  c: Context<AppBindings>,
  projectId: string,
  rawBody: unknown,
) {
  const db = getDb(c.env);

  // Coerce shorthand error forms into Sentry-shape so the rest of the pipeline is unchanged.
  const ev = coerceErrorBody(rawBody);
  const parsed = IngestEventSchema.safeParse(ev);
  if (!parsed.success) throw errors.invalidPayload({ zod: parsed.error.flatten() });
  const data = parsed.data;

  const exc = data.exception?.values?.[0];
  const errorType = (exc?.type ?? "Error").toString().slice(0, 200) || "Error";
  const messageRaw =
    (typeof exc?.value === "string" && exc.value) ||
    (typeof data.message === "string" && data.message) ||
    (data.message && typeof data.message === "object" &&
      ((data.message as { formatted?: string }).formatted ??
        (data.message as { message?: string }).message)) ||
    "";
  const message = (messageRaw || "").toString().slice(0, 4000);
  const frames: StackFrame[] =
    (exc?.stacktrace?.frames as StackFrame[] | undefined) ?? [];

  const fingerprint = await computeFingerprint({ errorType, message, frames });
  const deploySha =
    (typeof data.deploy_sha === "string" && data.deploy_sha) ||
    (typeof data.release === "string" && data.release) ||
    null;
  const environment = typeof data.environment === "string" ? data.environment : null;

  const userObj = (data.user ?? {}) as { id?: unknown; email?: unknown };
  const userId =
    typeof userObj.id === "string" || typeof userObj.id === "number"
      ? String(userObj.id).slice(0, 200)
      : null;
  const userEmail =
    typeof userObj.email === "string" ? userObj.email.slice(0, 320) : null;

  const maxSuppressions = parsePositiveInt(c.env.MAX_SUPPRESSIONS_PER_PROJECT, 200);
  const suppressions = await db
    .select()
    .from(suppressionEntries)
    .where(eq(suppressionEntries.projectId, projectId))
    .limit(maxSuppressions);
  const matched = suppressions.find((s) => matchesPattern(s.fingerprintPattern, fingerprint));

  if (matched && matched.action === "auto_ignore") {
    return c.json(
      {
        detected_kind: "error" as const,
        suppressed: true,
        next_action: "This fingerprint matches an auto_ignore rule. No case was created.",
      },
      202,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const eventId = uuidv7();
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
    breadcrumbsJson: data.breadcrumbs ? JSON.stringify(data.breadcrumbs) : null,
    requestJson: data.request ? JSON.stringify(data.request) : null,
    tagsJson: data.tags ? JSON.stringify(data.tags) : null,
    extraJson: data.extra ? JSON.stringify(data.extra) : null,
    receivedAt: now,
  });

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

  await incrementUsage(c.env, projectId, "errors");

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

  return c.json({
    detected_kind: "error" as const,
    event_id: eventId,
    case_id: caseId,
    suppressed: false,
    next_action: `Error captured. Investigate via GET /v1/cases/${caseId}.`,
  });
}

async function handleDeploySignal(
  c: Context<AppBindings>,
  projectId: string,
  rawBody: unknown,
) {
  const db = getDb(c.env);
  const b = (rawBody ?? {}) as Record<string, unknown>;
  const sha = typeof b.sha === "string" ? b.sha.slice(0, 200) : null;
  if (!sha) throw errors.invalidPayload({ reason: "deploy events require sha" });

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
    detected_kind: "deploy" as const,
    deploy_id: id,
    sha,
    received_at: now,
    next_action:
      "Deploy recorded. Future cases ingested after this timestamp surface this deploy in their recent_deploys.",
  });
}

async function handleEventSignal(
  c: Context<AppBindings>,
  projectId: string,
  userId: string,
  rawBody: unknown,
) {
  if (!isPosthogConfigured(c.env)) {
    return c.json(
      {
        detected_kind: "event" as const,
        accepted: false,
        next_action:
          "Analytics ingest is disabled because PostHog is not configured. Set POSTHOG_HOST + " +
          "POSTHOG_ORG_ID + POSTHOG_MASTER_API_KEY + AGENTRY_TOKEN_ENC_KEY on the agentry deployment.",
      },
      503,
    );
  }
  const b = (rawBody ?? {}) as Record<string, unknown>;
  const event = typeof b.event === "string" ? b.event.slice(0, 200) : "log";
  const distinct_id = typeof b.distinct_id === "string" ? b.distinct_id : undefined;
  const properties =
    b.properties && typeof b.properties === "object"
      ? (b.properties as Record<string, unknown>)
      : (() => {
          const { event: _e, distinct_id: _d, kind: _k, timestamp: _t, ...rest } = b;
          void _e; void _d; void _k; void _t;
          return rest;
        })();

  const result = await forwardCapture(c.env, userId, {
    event,
    distinct_id,
    properties,
    timestamp: typeof b.timestamp === "number" ? b.timestamp : undefined,
  });

  if (result.status < 400) await incrementUsage(c.env, projectId, "analytics");
  if (result.status >= 400) {
    return c.json(
      {
        detected_kind: "event" as const,
        accepted: false,
        next_action: "PostHog returned a non-2xx; check that the user's project is provisioned.",
        details: result.reason ? { posthog_response: result.reason } : undefined,
      },
      502,
    );
  }
  return c.json({
    detected_kind: "event" as const,
    event,
    accepted: true,
    next_action:
      "Event forwarded to PostHog. Use agentry_analytics_query (or the PostHog UI) to verify it landed.",
  });
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function coerceErrorBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    return {
      exception: {
        values: [{ type: "Error", value: String(body), stacktrace: { frames: [] } }],
      },
    };
  }
  const b = body as Record<string, unknown>;
  // If already Sentry-shape, pass through.
  if (b.exception) return b;

  // {name, message, stack} → Sentry envelope
  if (typeof b.name === "string" || typeof b.message === "string" || typeof b.stack === "string") {
    return {
      ...b,
      exception: {
        values: [
          {
            type: typeof b.name === "string" ? b.name : (typeof b.error_type === "string" ? b.error_type : "Error"),
            value: typeof b.message === "string" ? b.message : "",
            stacktrace: {
              frames: parseRawStack(typeof b.stack === "string" ? b.stack : ""),
            },
          },
        ],
      },
    };
  }
  // Fall back: nothing useful, treat as a no-stack error.
  return {
    exception: {
      values: [{ type: "Error", value: JSON.stringify(b).slice(0, 500), stacktrace: { frames: [] } }],
    },
  };
}

// Minimal V8-format stack parser for non-SDK callers (curl, raw HTTP from Python, etc).
// Best-effort; if we can't parse, leave frames empty and rely on message-based fingerprinting.
function parseRawStack(stack: string): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const m1 = line.match(/^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/);
    if (m1) {
      frames.push({
        function: m1[1] ?? null,
        filename: m1[2] ?? null,
        lineno: m1[3] ? Number(m1[3]) : null,
        colno: m1[4] ? Number(m1[4]) : null,
      });
      continue;
    }
    const m2 = line.match(/^\s*at\s+(.+):(\d+):(\d+)\s*$/);
    if (m2) {
      frames.push({
        function: null,
        filename: m2[1] ?? null,
        lineno: m2[2] ? Number(m2[2]) : null,
        colno: m2[3] ? Number(m2[3]) : null,
      });
    }
  }
  return frames;
}

// ---------------------------------------------------------------------------

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
