import { Hono } from "hono";
import { AgentryError, errors } from "@agentry/shared";
import authRoutes from "./routes/auth.js";
import projectRoutes from "./routes/projects.js";
import { caseRouter, projectScopedCases } from "./routes/cases.js";
import suppressionRoutes from "./routes/suppressions.js";
import ingestRoutes from "./routes/ingest.js";
import discoveryRoutes from "./routes/discovery.js";
import deployRoutes from "./routes/deploys.js";
import trackRoutes from "./routes/track.js";
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

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
