import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { errors, uuidv7 } from "@agentrysh/shared";
import { webhooks } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import {
  SERVER_EVENTS,
  fireWebhooks,
  mintSigningSecret,
  persistWebhook,
} from "../webhooks.js";
import { isPosthogConfigured } from "../posthog.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

router.use("/v1/projects/:project_id/webhooks/*", requireApiKey());
router.use("/v1/projects/:project_id/webhooks", requireApiKey());

// Register a webhook
router.post("/v1/projects/:project_id/webhooks", async (c) => {
  if (!isPosthogConfigured(c.env)) {
    // We only need AGENTRY_TOKEN_ENC_KEY for webhooks; that's part of the
    // PostHog config bundle. Surface the actual missing var.
    if (!c.env.AGENTRY_TOKEN_ENC_KEY) {
      throw errors.internal(
        "Webhooks require AGENTRY_TOKEN_ENC_KEY to encrypt signing secrets at rest. " +
          "Set this via `wrangler secret put AGENTRY_TOKEN_ENC_KEY` (32-byte base64url AES-256 key).",
      );
    }
  }
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  const b = body as Record<string, unknown> | null;
  const url = typeof b?.url === "string" ? b.url : null;
  if (!url || !/^https?:\/\//.test(url)) {
    throw errors.invalidPayload({ reason: "url is required and must be http(s)" });
  }
  // Free-form: any non-empty string is a valid subscription. Wildcards "*" and
  // "prefix.*" are supported. Server-emitted names (case.*, deploy.recorded,
  // alert.*) are listed in SERVER_EVENTS for discovery; analytics event names
  // are whatever the customer emits.
  const eventsRaw = Array.isArray(b?.events) ? (b.events as unknown[]) : [];
  const filtered: string[] = [];
  for (const e of eventsRaw) {
    if (typeof e !== "string") continue;
    const trimmed = e.trim().slice(0, 200);
    if (trimmed.length > 0) filtered.push(trimmed);
  }
  if (filtered.length === 0) {
    throw errors.invalidPayload({
      reason:
        "events must be a non-empty array of strings. " +
        `Server-emitted names: ${SERVER_EVENTS.join(", ")}. ` +
        "Analytics event names are also subscribable (signup_completed, purchase, etc.). " +
        "Wildcards: \"*\" matches all events, \"case.*\" matches the case namespace.",
    });
  }
  const description = typeof b?.description === "string" ? b.description.slice(0, 500) : null;

  const id = uuidv7();
  const secret = await mintSigningSecret();
  await persistWebhook(c.env, {
    id,
    projectId,
    url,
    description,
    events: filtered,
    secret,
  });

  return c.json({
    id,
    url,
    events: filtered,
    description,
    signing_secret: secret.raw,
    signing_secret_prefix: secret.prefix,
    next_action:
      "Store this signing_secret — it won't be shown again. Your endpoint must verify the " +
      "X-Agentry-Signature header (format: 't=<unix>,v1=<hex>'). " +
      "Recompute HMAC-SHA256(rawBody, signing_secret) and compare with constant-time equality. " +
      "Test the wiring by calling POST /v1/projects/:project_id/webhooks/:id/test.",
  });
});

router.get("/v1/projects/:project_id/webhooks", async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);
  const db = getDb(c.env);
  const rows = await db.select().from(webhooks).where(eq(webhooks.projectId, projectId));
  return c.json({
    webhooks: rows.map((w) => ({
      id: w.id,
      url: w.url,
      description: w.description,
      events: safeJsonArray<string>(w.events),
      signing_secret_prefix: w.signingSecretPrefix,
      active: w.active === 1,
      created_at: w.createdAt,
      last_fired_at: w.lastFiredAt,
      last_status: w.lastStatus,
      last_error: w.lastError,
    })),
    next_action:
      "If last_status is non-2xx or last_error is set, your endpoint isn't healthy. " +
      "Call /v1/projects/:project_id/webhooks/:id/test to retry.",
  });
});

router.delete("/v1/projects/:project_id/webhooks/:id", async (c) => {
  const projectId = c.req.param("project_id");
  const id = c.req.param("id");
  await requireProjectAccess(c, projectId);
  const db = getDb(c.env);
  const before = await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
  if (!before[0] || before[0].projectId !== projectId) throw errors.notFound("webhook");
  await db.delete(webhooks).where(eq(webhooks.id, id));
  return c.json({ ok: true, id, next_action: "Webhook removed. No further deliveries to this URL." });
});

router.post("/v1/projects/:project_id/webhooks/:id/test", async (c) => {
  const projectId = c.req.param("project_id");
  const id = c.req.param("id");
  await requireProjectAccess(c, projectId);
  await fireWebhooks(
    c.env,
    projectId,
    "case.created",
    {
      synthetic: true,
      message: "This is a synthetic test event from POST /webhooks/:id/test.",
      ts: Math.floor(Date.now() / 1000),
    },
    { webhookId: id, ignoreActive: true },
  );
  return c.json({
    ok: true,
    next_action:
      "Test event fired. Call GET /v1/projects/:project_id/webhooks to see last_status — " +
      "should be 200 if your endpoint accepted it.",
  });
});

function safeJsonArray<T>(s: string): T[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export default router;
