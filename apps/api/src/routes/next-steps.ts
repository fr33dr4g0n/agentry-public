import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { cases, deploys } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import { selectApplicableNextSteps } from "../next-steps.js";
import { isPosthogConfigured } from "../posthog.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

router.get(
  "/v1/projects/:project_id/next-steps",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectAccess(c, projectId);

    // Compute project state cheaply.
    const db = getDb(c.env);
    const [caseRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(cases)
      .where(eq(cases.projectId, projectId));
    const [deployRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(deploys)
      .where(eq(deploys.projectId, projectId));

    const state = {
      analytics_configured: isPosthogConfigured(c.env),
      has_events: false, // We don't store analytics events locally — assume true once analytics configured
      has_cases: Number(caseRow?.count ?? 0) > 0,
      has_deploys: Number(deployRow?.count ?? 0) > 0,
      install_verified: true, // best-effort signal; the MCP knows for sure via local config
    };
    // If analytics is configured, we treat has_events as true since we can't cheaply
    // probe PostHog from here. Recipes that hit PostHog will fail gracefully if empty.
    if (state.analytics_configured) state.has_events = true;

    const applicable = selectApplicableNextSteps(state);
    return c.json({
      project_state: state,
      count: applicable.length,
      suggestions: applicable,
      next_action:
        "Surface these to the user as numbered options. Each has a `prompt_template` the user can " +
        "paste verbatim — that prompt invokes the listed `uses` and produces the described output.",
    });
  },
);

export default router;
