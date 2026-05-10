import { Hono } from "hono";
import { cors } from "hono/cors";
import { AgentryError, errors } from "@agentry/shared";
import authRoutes from "./routes/auth.js";
import projectRoutes from "./routes/projects.js";
import { caseRouter, projectScopedCases } from "./routes/cases.js";
import suppressionRoutes from "./routes/suppressions.js";
import ingestRoutes from "./routes/ingest.js";
import discoveryRoutes from "./routes/discovery.js";
import deployRoutes from "./routes/deploys.js";
import trackRoutes from "./routes/track.js";
import logRoutes from "./routes/log.js";
import recipeRoutes from "./routes/recipes.js";
import nextStepsRoutes from "./routes/next-steps.js";
import webhookRoutes from "./routes/webhooks.js";
import healthRoutes from "./routes/health.js";
import alertRoutes from "./routes/alerts.js";
import userRoutes from "./routes/users.js";
import type { AppBindings, Env } from "./env.js";

export function createApp() {
  const app = new Hono<AppBindings>();

  // Structured JSON logging — readable in `wrangler tail`.
  app.use("*", async (c, next) => {
    const start = Date.now();
    let status = 0;
    let errorCode: string | undefined;
    try {
      await next();
      status = c.res.status;
    } catch (err) {
      status = err instanceof AgentryError ? err.status : 500;
      errorCode = err instanceof AgentryError ? err.code : "unhandled";
      throw err;
    } finally {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          method: c.req.method,
          path: new URL(c.req.url).pathname,
          status,
          dur_ms: Date.now() - start,
          ...(errorCode ? { error_code: errorCode } : {}),
        }),
      );
    }
  });

  // Centralized error handling.
  app.onError((err, c) => {
    if (err instanceof AgentryError) {
      // Hono's StatusCode union accepts standard codes; cast through ContentfulStatusCode shape.
      return new Response(JSON.stringify(err.toResponseBody()), {
        status: err.status,
        headers: { "content-type": "application/json" },
      });
    }
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        unhandled: true,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
    const internal = errors.internal();
    return new Response(JSON.stringify(internal.toResponseBody()), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });

  app.notFound(() => {
    const e = errors.notFound("route");
    return new Response(JSON.stringify(e.toResponseBody()), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });

  // CORS for browser SDKs. Only the ingest paths need wildcard origins —
  // they're DSN-authenticated and the DSN is meant for client-side use.
  // Auth/management endpoints (cases, projects, auth) intentionally omit CORS:
  // browsers shouldn't be calling them, and a same-origin browser context
  // would just echo a CORS error which surfaces the misuse fast.
  app.use(
    "/v1/store/*",
    cors({
      origin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["authorization", "content-type", "x-sentry-auth"],
      maxAge: 86400,
    }),
  );
  app.use(
    "/v1/track/*",
    cors({
      origin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["authorization", "content-type", "x-sentry-auth"],
      maxAge: 86400,
    }),
  );
  app.use(
    "/v1/deploys/*",
    cors({
      origin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["authorization", "content-type", "x-sentry-auth"],
      maxAge: 86400,
    }),
  );
  app.use(
    "/v1/log/*",
    cors({
      origin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["authorization", "content-type", "x-sentry-auth"],
      maxAge: 86400,
    }),
  );

  // Discovery / root
  app.route("/", discoveryRoutes);

  // Auth
  app.route("/v1/auth", authRoutes);

  // Projects (also nests project-scoped subroutes via path, see below)
  app.route("/v1/projects", projectRoutes);

  // Project-scoped cases listing: GET /v1/projects/:project_id/cases
  // Mounted at root because the routes already include the full path.
  app.route("/v1", projectScopedCases);

  // Suppressions: POST/GET /v1/projects/:project_id/suppressions
  app.route("/v1", suppressionRoutes);

  // Cases by id: /v1/cases/:case_id
  app.route("/v1/cases", caseRouter);

  // Ingest: /v1/store/:project_id/
  app.route("/v1", ingestRoutes);

  // Deploy events (POST DSN-auth, GET api-key-auth, full paths)
  app.route("/", deployRoutes);

  // Analytics: /v1/track/:project_id/ (DSN), /v1/projects/:id/analytics/query (api key)
  app.route("/", trackRoutes);

  // Unified "just log anything" endpoint — auto-detects what kind of signal it is.
  app.route("/", logRoutes);

  // Recipes — canonical query templates the agent can run for common asks.
  app.route("/", recipeRoutes);

  // Suggested next-steps for post-install conversational prompts.
  app.route("/", nextStepsRoutes);

  // Webhook subscriptions (signed POST delivery on case.created / case.resolved / deploy.recorded).
  app.route("/", webhookRoutes);

  // Project health (last_event_at, usage, webhook health).
  app.route("/", healthRoutes);

  // Alerts (stored definitions; customer's cron POSTs /evaluate).
  app.route("/", alertRoutes);

  // User identification views (per-project + per-case).
  app.route("/", userRoutes);

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
