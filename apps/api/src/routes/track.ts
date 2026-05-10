import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { errors, parseDsn, sha256Hex } from "@agentry/shared";
import { projects } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import { forwardCapture, isPosthogConfigured, runHogQl } from "../posthog.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// Analytics ingest. Customer's app POSTs analytics events here using their DSN
// (same auth as error ingest); we forward to their PostHog project.
// ---------------------------------------------------------------------------

router.post("/v1/track/:project_id/", async (c) => handleTrack(c));
router.post("/v1/track/:project_id", async (c) => handleTrack(c));

async function handleTrack(c: import("hono").Context<AppBindings>) {
  if (!isPosthogConfigured(c.env)) {
    return c.json(
      {
        error: {
          code: "analytics_not_configured",
          message:
            "PostHog is not configured on this agentry deployment. Analytics ingest is disabled.",
          next_action:
            "If you're the operator: set POSTHOG_HOST, POSTHOG_ORG_ID, POSTHOG_MASTER_API_KEY, AGENTRY_TOKEN_ENC_KEY via `wrangler secret put`.",
        },
      },
      503,
    );
  }

  const projectId = c.req.param("project_id");
  if (!projectId) throw errors.notFound("project");

  // DSN auth (same as ingest).
  const presented = extractAuthToken(c);
  if (!presented) throw errors.invalidDsn();

  const db = getDb(c.env);
  const projRows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
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
    const parsed = parseDsn(presented);
    if (parsed && parsed.projectId !== projectId) throw errors.invalidDsn();
    throw errors.invalidDsn();
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }

  const b = body as Record<string, unknown> | null;
  const event = typeof b?.event === "string" ? b.event.slice(0, 200) : null;
  if (!event) throw errors.invalidPayload({ reason: "event is required" });

  const result = await forwardCapture(c.env, proj.userId, {
    event,
    distinct_id: typeof b.distinct_id === "string" ? b.distinct_id : undefined,
    properties:
      b.properties && typeof b.properties === "object"
        ? (b.properties as Record<string, unknown>)
        : {},
    timestamp: typeof b.timestamp === "number" ? b.timestamp : undefined,
  });

  if (result.status >= 400) {
    return c.json(
      {
        error: {
          code: "posthog_capture_failed",
          message: `PostHog returned ${result.status}.`,
          next_action:
            "Check that the user's PostHog project is provisioned. Re-running agentry_login once may re-provision it.",
          details: result.reason ? { posthog_response: result.reason } : undefined,
        },
      },
      502,
    );
  }

  return c.json({
    ok: true,
    event,
    next_action:
      "Event forwarded to PostHog. Use agentry_funnel_review or agentry_event_search to query it once propagation completes (a few seconds).",
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

// ---------------------------------------------------------------------------
// Agent-facing analytics queries.
// ---------------------------------------------------------------------------

router.post(
  "/v1/projects/:project_id/analytics/query",
  requireApiKey(),
  async (c) => {
    if (!isPosthogConfigured(c.env)) {
      throw errors.internal(
        "PostHog not configured. Set POSTHOG_HOST + POSTHOG_ORG_ID + POSTHOG_MASTER_API_KEY + AGENTRY_TOKEN_ENC_KEY.",
      );
    }
    const projectId = c.req.param("project_id");
    const proj = await requireProjectAccess(c, projectId);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw errors.invalidPayload({ reason: "body is not valid JSON" });
    }
    const query =
      body && typeof body === "object" && typeof (body as { query?: unknown }).query === "string"
        ? (body as { query: string }).query
        : null;
    if (!query) throw errors.invalidPayload({ reason: "query (HogQL string) is required" });
    if (query.length > 4000) {
      throw errors.invalidPayload({ reason: "query exceeds 4000-char limit" });
    }

    const out = await runHogQl(c.env, proj.userId, query);
    return c.json({
      results: out.results,
      columns: out.columns,
      types: out.types,
      next_action:
        "Interpret the rows. If the agent suspects a regression, cross-reference with /v1/projects/:id/deploys to find the responsible deploy.",
    });
  },
);

export default router;
