import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { errors, parseDsn, sha256Hex } from "@agentrysh/shared";
import { projects } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import { forwardCapture, isPosthogConfigured, runHogQl } from "../posthog.js";
import { incrementUsage } from "../usage.js";
import { fireWebhooks } from "../webhooks.js";
import { waitUntilOf } from "../middleware.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// Analytics ingest. Customer's app POSTs analytics events here using their DSN
// (same auth as error ingest); we forward to their PostHog project.
// ---------------------------------------------------------------------------

// First-party path. Use this from new code.
router.post("/v1/analytics/:project_id/", async (c) => handleTrack(c));
router.post("/v1/analytics/:project_id", async (c) => handleTrack(c));

// PostHog-style alias. Kept so existing PostHog-shaped clients still capture.
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

  if (result.status < 400) await incrementUsage(c.env, projectId, "analytics");
  if (result.status >= 400) {
    const isNoProject =
      result.reason === "user has no PostHog project provisioned";
    return c.json(
      {
        error: {
          code: isNoProject ? "no_posthog_project" : "posthog_capture_failed",
          message: isNoProject
            ? "This user has no PostHog project provisioned (first-login provisioning failed)."
            : `PostHog returned ${result.status}.`,
          next_action: isNoProject
            ? "Call agentry_repair_analytics (or POST /v1/auth/posthog/provision with the api_key). " +
              "It's idempotent and runs the provisioning step that should have happened at login. " +
              "DO NOT re-run agentry_login — that mints a new api_key and churns the user's config."
            : "If PostHog is 5xx temporarily, retry in 30–60s. If the failure persists, run " +
              "agentry_repair_analytics to re-attempt provisioning.",
          details: result.reason ? { posthog_response: result.reason } : undefined,
        },
      },
      502,
    );
  }

  // Fire webhooks subscribed to this event name.
  const waitUntil = waitUntilOf(c);
  await fireWebhooks(
    c.env,
    projectId,
    event,
    {
      event,
      distinct_id: typeof b?.distinct_id === "string" ? b.distinct_id : null,
      properties:
        b?.properties && typeof b.properties === "object"
          ? (b.properties as Record<string, unknown>)
          : {},
      timestamp: typeof b?.timestamp === "number" ? b.timestamp : Math.floor(Date.now() / 1000),
    },
    { waitUntil },
  );

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

// Discovery: distinct event names flowing through this project in the last 30
// days, plus the canonical server-emitted event names. The agent uses this to
// pick what to subscribe a webhook to.
router.get(
  "/v1/projects/:project_id/event-names",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    const proj = await requireProjectAccess(c, projectId);

    let analytics: Array<{ event: string; count: number; last_seen: number }> = [];
    if (isPosthogConfigured(c.env)) {
      try {
        const out = await runHogQl(
          c.env,
          proj.userId,
          "SELECT event, count() AS c, max(timestamp) AS last_seen " +
            "FROM events WHERE timestamp > now() - INTERVAL 30 DAY " +
            "GROUP BY event ORDER BY c DESC LIMIT 200",
        );
        analytics = (out.results ?? []).map((row) => {
          const r = row as unknown[];
          return {
            event: String(r[0] ?? ""),
            count: Number(r[1] ?? 0),
            last_seen: typeof r[2] === "number" ? r[2] : 0,
          };
        }).filter((r) => r.event.length > 0);
      } catch {
        // Discovery is best-effort; if HogQL fails, return server names only.
      }
    }

    const SERVER_EMITTED = [
      "case.created", "case.resolved", "case.investigating",
      "case.spurious", "case.ignored", "case.reopened",
      "deploy.recorded",
      "alert.triggered", "alert.recovered",
    ];

    return c.json({
      server_emitted: SERVER_EMITTED,
      analytics_events: analytics,
      wildcards: ["*", "case.*", "alert.*"],
      next_action:
        "Pick any string from server_emitted, analytics_events, or wildcards as a webhook event " +
        "subscription. Pass the chosen names to agentry_register_webhook. Analytics names also " +
        "support any string the customer's app emits in the future — subscribe before they exist " +
        "and the hook will fire as soon as the event flows.",
    });
  },
);

export default router;
