// PostHog per-user-team CRUD: feature flags, cohorts, surveys, session
// replay retrieval. All endpoints are api-key authed and scoped to the
// user's PostHog team via getPosthogProjectForUser.
//
// Auth model: agentry's master Personal API Key (POSTHOG_MASTER_API_KEY)
// has org-admin scope. We pin the team_id from the agentry user_id and
// hit PostHog's own per-team REST API. PostHog enforces team-level
// isolation natively — the master key authenticates, the team_id in the
// URL scopes.
//
// Required PostHog scopes on the master key (rotated 2026-05-15 to `*`):
//   feature_flag:read,write   cohort:read,write
//   survey:read,write         session_recording:read
//
// MCP tools wrap each endpoint 1:1 (see packages/mcp/src/tools.ts).

import { Hono } from "hono";
import { errors } from "@agentrysh/shared";
import { isPosthogConfigured, posthogTeamApi, posthogWebUrl } from "../posthog.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJsonBody(c: Parameters<Parameters<typeof router.post>[1]>[0]): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    throw errors.invalidPayload({ reason: "body must be JSON" });
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== "string" || !v) {
    throw errors.invalidPayload({ reason: `'${field}' (string) is required` });
  }
  return v;
}

function ensurePosthog(env: Parameters<typeof posthogTeamApi>[0]): void {
  if (!isPosthogConfigured(env)) {
    throw errors.internal(
      "PostHog not configured on this deployment. Set POSTHOG_HOST + POSTHOG_ORG_ID + POSTHOG_MASTER_API_KEY + AGENTRY_TOKEN_ENC_KEY.",
    );
  }
}

// ===========================================================================
// FEATURE FLAGS
// ---------------------------------------------------------------------------
// PostHog's flag model: {key, name, active, filters: {groups: [{properties,
// rollout_percentage}]}, variants}. We expose a thin shape — agents can pass
// raw `filters` for advanced rules; for the common case we accept
// {key, name, rollout_percentage, active} and assemble the filters.
// ===========================================================================

router.get(
  "/v1/projects/:project_id/feature-flags",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 200);
    const { teamId, data } = await posthogTeamApi<{ results?: unknown[]; count?: number }>(
      c.env,
      proj.userId,
      "feature_flags/",
      { query: { limit } },
    );
    return c.json({
      team_id: teamId,
      flags: data.results ?? [],
      count: data.count ?? (Array.isArray(data.results) ? data.results.length : 0),
      web_ui_url: posthogWebUrl(c.env, teamId, "feature_flags"),
      next_action:
        "Use agentry_create_feature_flag to add one, or agentry_get_feature_flag to inspect.",
    });
  },
);

router.get(
  "/v1/projects/:project_id/feature-flags/:flag_id",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const flagId = c.req.param("flag_id");
    const { teamId, data } = await posthogTeamApi(
      c.env,
      proj.userId,
      `feature_flags/${encodeURIComponent(flagId)}/`,
    );
    return c.json({
      team_id: teamId,
      flag: data,
      web_ui_url: posthogWebUrl(c.env, teamId, `feature_flags/${encodeURIComponent(flagId)}`),
    });
  },
);

router.post(
  "/v1/projects/:project_id/feature-flags",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const body = await readJsonBody(c);
    const key = requireString(body, "key");
    const name = typeof body.name === "string" ? body.name : key;
    const active = body.active === undefined ? true : Boolean(body.active);
    const rollout =
      typeof body.rollout_percentage === "number"
        ? Math.max(0, Math.min(100, body.rollout_percentage))
        : 100;
    // If caller passed a full `filters` block, use it as-is (advanced rules).
    // Otherwise assemble a single-group filter with the rollout percentage.
    const filters =
      body.filters && typeof body.filters === "object"
        ? body.filters
        : { groups: [{ properties: [], rollout_percentage: rollout }] };

    const { teamId, data } = await posthogTeamApi(
      c.env,
      proj.userId,
      "feature_flags/",
      {
        method: "POST",
        body: { key, name, active, filters },
      },
    );
    return c.json({
      team_id: teamId,
      flag: data,
      web_ui_url: posthogWebUrl(c.env, teamId, "feature_flags"),
      next_action:
        "Flag created. Toggle via agentry_update_feature_flag({active}) or delete via agentry_delete_feature_flag.",
    });
  },
);

router.patch(
  "/v1/projects/:project_id/feature-flags/:flag_id",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const flagId = c.req.param("flag_id");
    const body = await readJsonBody(c);
    const patch: Record<string, unknown> = {};
    if (typeof body.active === "boolean") patch.active = body.active;
    if (typeof body.name === "string") patch.name = body.name;
    if (body.filters && typeof body.filters === "object") patch.filters = body.filters;
    if (typeof body.rollout_percentage === "number") {
      const rollout = Math.max(0, Math.min(100, body.rollout_percentage));
      patch.filters = { groups: [{ properties: [], rollout_percentage: rollout }] };
    }
    if (Object.keys(patch).length === 0) {
      throw errors.invalidPayload({
        reason: "patch must include at least one of: active, name, filters, rollout_percentage",
      });
    }
    const { teamId, data } = await posthogTeamApi(
      c.env,
      proj.userId,
      `feature_flags/${encodeURIComponent(flagId)}/`,
      { method: "PATCH", body: patch },
    );
    return c.json({ team_id: teamId, flag: data });
  },
);

router.delete(
  "/v1/projects/:project_id/feature-flags/:flag_id",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const flagId = c.req.param("flag_id");
    // PostHog soft-deletes flags via PATCH {deleted: true}, then a permanent
    // delete is a DELETE. Soft-delete is the safer default the agent should
    // expose — recoverable via the web UI.
    const { teamId } = await posthogTeamApi(
      c.env,
      proj.userId,
      `feature_flags/${encodeURIComponent(flagId)}/`,
      { method: "PATCH", body: { deleted: true } },
    );
    return c.json({ team_id: teamId, deleted: flagId, soft: true });
  },
);

// ===========================================================================
// COHORTS
// ---------------------------------------------------------------------------
// Cohorts can be static (manual person list) or dynamic (filter by event
// history). We expose the common dynamic case.
// ===========================================================================

router.get(
  "/v1/projects/:project_id/cohorts",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const { teamId, data } = await posthogTeamApi<{ results?: unknown[]; count?: number }>(
      c.env,
      proj.userId,
      "cohorts/",
      { query: { limit: 100 } },
    );
    return c.json({
      team_id: teamId,
      cohorts: data.results ?? [],
      count: data.count ?? (Array.isArray(data.results) ? data.results.length : 0),
      web_ui_url: posthogWebUrl(c.env, teamId, "cohorts"),
    });
  },
);

router.get(
  "/v1/projects/:project_id/cohorts/:cohort_id",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const cohortId = c.req.param("cohort_id");
    const { teamId, data } = await posthogTeamApi(
      c.env,
      proj.userId,
      `cohorts/${encodeURIComponent(cohortId)}/`,
    );
    return c.json({
      team_id: teamId,
      cohort: data,
      web_ui_url: posthogWebUrl(c.env, teamId, `cohorts/${encodeURIComponent(cohortId)}`),
    });
  },
);

router.post(
  "/v1/projects/:project_id/cohorts",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const body = await readJsonBody(c);
    const name = requireString(body, "name");
    // Caller can pass full `groups` (PostHog's cohort filter format), or a
    // simple {event, days?} shape — agent uses the simple form by default.
    let groups: unknown;
    if (Array.isArray(body.groups)) {
      groups = body.groups;
    } else if (typeof body.event === "string") {
      const days = typeof body.days === "number" ? body.days : 30;
      groups = [
        {
          action_id: null,
          event_id: body.event,
          days,
          count: 1,
          count_operator: "gte",
          start_date: null,
          end_date: null,
        },
      ];
    } else {
      throw errors.invalidPayload({
        reason:
          "cohort body must include 'event' (string, simple case) or 'groups' (PostHog filter format)",
      });
    }
    const { teamId, data } = await posthogTeamApi(
      c.env,
      proj.userId,
      "cohorts/",
      {
        method: "POST",
        body: { name, is_static: false, groups },
      },
    );
    return c.json({
      team_id: teamId,
      cohort: data,
      web_ui_url: posthogWebUrl(c.env, teamId, "cohorts"),
      next_action:
        "Cohort created — PostHog recalculates membership async. Use the cohort id in feature-flag filters or HogQL `person_id IN (SELECT … FROM cohort_people WHERE cohort_id = N)`.",
    });
  },
);

router.delete(
  "/v1/projects/:project_id/cohorts/:cohort_id",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const cohortId = c.req.param("cohort_id");
    // PostHog cohorts also soft-delete via PATCH {deleted: true}.
    const { teamId } = await posthogTeamApi(
      c.env,
      proj.userId,
      `cohorts/${encodeURIComponent(cohortId)}/`,
      { method: "PATCH", body: { deleted: true } },
    );
    return c.json({ team_id: teamId, deleted: cohortId, soft: true });
  },
);

// ===========================================================================
// SURVEYS
// ---------------------------------------------------------------------------
// Surveys = popup/banner forms (NPS, CSAT, open-ended). PostHog's web
// surveys library renders them client-side based on team config. Responses
// land as `survey sent` events and are queryable via HogQL.
// ===========================================================================

router.get(
  "/v1/projects/:project_id/surveys",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const { teamId, data } = await posthogTeamApi<{ results?: unknown[]; count?: number }>(
      c.env,
      proj.userId,
      "surveys/",
      { query: { limit: 100 } },
    );
    return c.json({
      team_id: teamId,
      surveys: data.results ?? [],
      count: data.count ?? (Array.isArray(data.results) ? data.results.length : 0),
      web_ui_url: posthogWebUrl(c.env, teamId, "surveys"),
    });
  },
);

router.get(
  "/v1/projects/:project_id/surveys/:survey_id",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const surveyId = c.req.param("survey_id");
    const { teamId, data } = await posthogTeamApi(
      c.env,
      proj.userId,
      `surveys/${encodeURIComponent(surveyId)}/`,
    );
    return c.json({
      team_id: teamId,
      survey: data,
      web_ui_url: posthogWebUrl(c.env, teamId, `surveys/${encodeURIComponent(surveyId)}`),
      next_action:
        "Read responses via HogQL: SELECT properties FROM events WHERE event = 'survey sent' AND properties.\\$survey_id = '<id>' LIMIT 100",
    });
  },
);

router.post(
  "/v1/projects/:project_id/surveys",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const body = await readJsonBody(c);
    const name = requireString(body, "name");
    const type = typeof body.type === "string" ? body.type : "popover";
    // Questions: caller can pass an explicit array. Otherwise we accept a
    // single-question quick shape {question, question_type}.
    let questions: unknown;
    if (Array.isArray(body.questions)) {
      questions = body.questions;
    } else if (typeof body.question === "string") {
      const qType = typeof body.question_type === "string" ? body.question_type : "open";
      questions = [{ type: qType, question: body.question }];
    } else {
      throw errors.invalidPayload({
        reason:
          "survey body must include 'questions' (array) or 'question' (string) + optional 'question_type'",
      });
    }
    const payload: Record<string, unknown> = {
      name,
      type,
      questions,
    };
    if (body.description) payload.description = body.description;
    if (body.linked_flag_id) payload.linked_flag_id = body.linked_flag_id;
    if (body.targeting_flag_id) payload.targeting_flag_id = body.targeting_flag_id;
    if (body.conditions) payload.conditions = body.conditions;
    if (body.appearance) payload.appearance = body.appearance;
    // PostHog requires explicit launch — agent calls again with start_date to launch.
    if (typeof body.start_date === "string") payload.start_date = body.start_date;

    const { teamId, data } = await posthogTeamApi(
      c.env,
      proj.userId,
      "surveys/",
      { method: "POST", body: payload },
    );
    return c.json({
      team_id: teamId,
      survey: data,
      web_ui_url: posthogWebUrl(c.env, teamId, "surveys"),
      next_action:
        "Survey created in draft. To launch, PATCH /surveys/:id with {start_date: '<ISO>'} (or pass start_date at create time). Responses arrive as 'survey sent' events.",
    });
  },
);

router.delete(
  "/v1/projects/:project_id/surveys/:survey_id",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const surveyId = c.req.param("survey_id");
    const { teamId } = await posthogTeamApi(
      c.env,
      proj.userId,
      `surveys/${encodeURIComponent(surveyId)}/`,
      { method: "DELETE" },
    );
    return c.json({ team_id: teamId, deleted: surveyId });
  },
);

// ===========================================================================
// SESSION RECORDINGS — retrieval
// ---------------------------------------------------------------------------
// Configuration (opt-in, sampling strategies) lives in posthog-config.ts.
// This is the read-side: list recordings (filterable by user/date) and
// fetch the metadata + player URL for one recording.
//
// Requires `session_recording:read` on the master key (granted 2026-05-15).
// ===========================================================================

router.get(
  "/v1/projects/:project_id/session-replays",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const query: Record<string, string | number | undefined> = {
      limit: Math.min(Math.max(Number(c.req.query("limit") ?? 25), 1), 100),
    };
    // Filterable: distinct_id (link to a specific user), date_from / date_to.
    const distinctId = c.req.query("distinct_id");
    if (distinctId) query.distinct_id = distinctId;
    const dateFrom = c.req.query("date_from");
    const dateTo = c.req.query("date_to");
    if (dateFrom) query.date_from = dateFrom;
    if (dateTo) query.date_to = dateTo;

    const { teamId, data } = await posthogTeamApi<{ results?: unknown[]; has_next?: boolean }>(
      c.env,
      proj.userId,
      "session_recordings/",
      { query },
    );
    return c.json({
      team_id: teamId,
      recordings: data.results ?? [],
      has_next: data.has_next ?? false,
      web_ui_url: posthogWebUrl(c.env, teamId, "replay/home"),
      next_action:
        "Each recording has an `id`; call agentry_get_session_replay(:id) to get the player URL and metadata.",
    });
  },
);

router.get(
  "/v1/projects/:project_id/session-replays/:replay_id",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const replayId = c.req.param("replay_id");
    const { teamId, data } = await posthogTeamApi(
      c.env,
      proj.userId,
      `session_recordings/${encodeURIComponent(replayId)}/`,
    );
    return c.json({
      team_id: teamId,
      recording: data,
      player_url: posthogWebUrl(c.env, teamId, `replay/${encodeURIComponent(replayId)}`),
      next_action:
        "Open player_url in a browser to watch the recording. Snapshot data is available via PostHog's /session_recordings/<id>/snapshots/ endpoint if you need to programmatically inspect the DOM events.",
    });
  },
);

export default router;
