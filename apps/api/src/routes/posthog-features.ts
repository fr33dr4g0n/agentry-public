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
import { isPosthogConfigured, posthogTeamApi, posthogWebUrl, runHogQl, getPosthogProjectForUser } from "../posthog.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import { audit } from "../audit.js";
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

    const { teamId, data } = await posthogTeamApi<{ id?: number; key?: string }>(
      c.env,
      proj.userId,
      "feature_flags/",
      {
        method: "POST",
        body: { key, name, active, filters },
      },
    );
    await audit(c, {
      userId: proj.userId,
      projectId: proj.id,
      action: "feature_flag.created",
      resourceType: "feature_flag",
      resourceId: data.id ?? null,
      summary: `Created feature flag '${data.key ?? key}'${active ? " (active)" : " (inactive)"} at ${rollout}% rollout`,
      metadata: { key: data.key ?? key, active, rollout_percentage: rollout },
    });
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
    const { teamId, data } = await posthogTeamApi<{ key?: string }>(
      c.env,
      proj.userId,
      `feature_flags/${encodeURIComponent(flagId)}/`,
      { method: "PATCH", body: patch },
    );
    await audit(c, {
      userId: proj.userId,
      projectId: proj.id,
      action: "feature_flag.updated",
      resourceType: "feature_flag",
      resourceId: flagId,
      summary: `Updated feature flag '${data.key ?? flagId}': ${Object.keys(patch).join(", ")}`,
      metadata: { patch_keys: Object.keys(patch) },
    });
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
    await audit(c, {
      userId: proj.userId,
      projectId: proj.id,
      action: "feature_flag.deleted",
      resourceType: "feature_flag",
      resourceId: flagId,
      summary: `Soft-deleted feature flag id=${flagId}`,
    });
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
    const { teamId, data } = await posthogTeamApi<{ id?: number }>(
      c.env,
      proj.userId,
      "cohorts/",
      {
        method: "POST",
        body: { name, is_static: false, groups },
      },
    );
    await audit(c, {
      userId: proj.userId,
      projectId: proj.id,
      action: "cohort.created",
      resourceType: "cohort",
      resourceId: data.id ?? null,
      summary: `Created cohort '${name}'`,
      metadata: { name, simple_event: typeof body.event === "string" ? body.event : null },
    });
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
    await audit(c, {
      userId: proj.userId,
      projectId: proj.id,
      action: "cohort.deleted",
      resourceType: "cohort",
      resourceId: cohortId,
      summary: `Soft-deleted cohort id=${cohortId}`,
    });
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

    const { teamId, data } = await posthogTeamApi<{ id?: string }>(
      c.env,
      proj.userId,
      "surveys/",
      { method: "POST", body: payload },
    );
    await audit(c, {
      userId: proj.userId,
      projectId: proj.id,
      action: "survey.created",
      resourceType: "survey",
      resourceId: data.id ?? null,
      summary: `Created survey '${name}'`,
      metadata: { name, type, launched: typeof body.start_date === "string" },
    });
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
    await audit(c, {
      userId: proj.userId,
      projectId: proj.id,
      action: "survey.deleted",
      resourceType: "survey",
      resourceId: surveyId,
      summary: `Deleted survey id=${surveyId}`,
    });
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
        "Open player_url in a browser to watch the recording. For programmatic DOM-event inspection, call agentry_get_replay_snapshots.",
    });
  },
);

router.get(
  "/v1/projects/:project_id/session-replays/:replay_id/snapshots",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const replayId = c.req.param("replay_id");
    // PostHog returns the rrweb snapshots tree. Source param is optional —
    // 'realtime' (default) for live replays, 'blob' for archived. We let
    // PostHog pick its default unless caller specifies.
    const sourceParam = c.req.query("source");
    const query: Record<string, string> = {};
    if (sourceParam) query.source = sourceParam;
    const { teamId, data } = await posthogTeamApi(
      c.env,
      proj.userId,
      `session_recordings/${encodeURIComponent(replayId)}/snapshots/`,
      { query },
    );
    return c.json({
      team_id: teamId,
      replay_id: replayId,
      snapshots: data,
      next_action:
        "Snapshots are rrweb-format DOM events. Each has type (Meta/FullSnapshot/IncrementalSnapshot) and timestamp. For agent inspection: filter by `type === 5` (custom user events) or click events (type=3, source=2) to reconstruct user actions.",
    });
  },
);

// ===========================================================================
// EVALUATE FEATURE FLAG — for one user, what flags are active?
// ---------------------------------------------------------------------------
// Uses PostHog's /decide/?v=3 endpoint — same call clients make at runtime
// to learn their flag values. Authed with the team's public write token
// (phc_), not the master key — /decide/ doesn't need master auth.
// ===========================================================================

router.post(
  "/v1/projects/:project_id/feature-flags/evaluate",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const body = await readJsonBody(c);
    const distinctId = requireString(body, "distinct_id");
    const flagKey = typeof body.key === "string" ? body.key : undefined;
    const personProperties =
      body.person_properties && typeof body.person_properties === "object"
        ? (body.person_properties as Record<string, unknown>)
        : undefined;
    const groupsParam =
      body.groups && typeof body.groups === "object"
        ? (body.groups as Record<string, string>)
        : undefined;

    const ph = await getPosthogProjectForUser(c.env, proj.userId);
    if (!ph) throw errors.notFound("posthog_project");

    const host = (c.env.POSTHOG_HOST ?? "").replace(/\/$/, "");
    const decidePayload: Record<string, unknown> = {
      api_key: ph.posthogProjectApiKey,
      distinct_id: distinctId,
      ...(personProperties ? { person_properties: personProperties } : {}),
      ...(groupsParam ? { groups: groupsParam } : {}),
    };
    const res = await fetch(`${host}/decide/?v=3`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decidePayload),
    });
    if (!res.ok) {
      const t = await res.text();
      throw errors.internal(`PostHog /decide/ ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      featureFlags?: Record<string, boolean | string>;
      featureFlagPayloads?: Record<string, unknown>;
    };
    const all = data.featureFlags ?? {};
    if (flagKey) {
      return c.json({
        team_id: ph.posthogProjectId,
        distinct_id: distinctId,
        key: flagKey,
        value: flagKey in all ? all[flagKey] : null,
        payload: data.featureFlagPayloads?.[flagKey] ?? null,
        next_action:
          flagKey in all
            ? null
            : `Flag '${flagKey}' is not defined or evaluates to false for this user. Check agentry_list_feature_flags.`,
      });
    }
    return c.json({
      team_id: ph.posthogProjectId,
      distinct_id: distinctId,
      flags: all,
      payloads: data.featureFlagPayloads ?? {},
      enabled_count: Object.values(all).filter((v) => v !== false).length,
    });
  },
);

// ===========================================================================
// DISTINCT_ID SUMMARY — composed user dossier
// ---------------------------------------------------------------------------
// One call returns: person properties, event count, first/last seen,
// recent events, recent recordings (if replay on), and a list of cases
// the user appears in (from agentry's own events table).
// ===========================================================================

router.get(
  "/v1/projects/:project_id/users/:distinct_id/summary",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const distinctId = c.req.param("distinct_id");
    if (!distinctId) {
      throw errors.invalidPayload({ reason: "distinct_id required in URL" });
    }

    const ph = await getPosthogProjectForUser(c.env, proj.userId);
    if (!ph) throw errors.notFound("posthog_project");

    // 1. PostHog person lookup. May not exist if the user hasn't been
    //    identified — that's fine, we degrade gracefully.
    let person: unknown = null;
    try {
      const { data } = await posthogTeamApi<{ results?: Array<{ properties?: Record<string, unknown>; id?: number }> }>(
        c.env,
        proj.userId,
        `persons/`,
        { query: { distinct_id: distinctId } },
      );
      person = (data.results ?? [])[0] ?? null;
    } catch (err) {
      // Non-fatal: we still return the HogQL-based view.
      console.warn("[distinct_id_summary] person lookup failed:", err);
    }

    // 2. HogQL: event count, first/last seen, recent events.
    let hogqlStats: { count: number; first_seen: string | null; last_seen: string | null } = {
      count: 0,
      first_seen: null,
      last_seen: null,
    };
    let recentEvents: Array<{ event: string; timestamp: string }> = [];
    try {
      const stats = await runHogQl(
        c.env,
        proj.userId,
        `SELECT count() AS n, min(timestamp) AS first_seen, max(timestamp) AS last_seen
         FROM events WHERE distinct_id = '${escapeSqlLiteral(distinctId)}'`,
      );
      const r0 = (stats.results[0] as [number, string, string] | undefined) ?? [0, null, null];
      hogqlStats = { count: r0[0] ?? 0, first_seen: r0[1] ?? null, last_seen: r0[2] ?? null };

      const events = await runHogQl(
        c.env,
        proj.userId,
        `SELECT event, timestamp FROM events
         WHERE distinct_id = '${escapeSqlLiteral(distinctId)}'
         ORDER BY timestamp DESC LIMIT 20`,
      );
      recentEvents = (events.results as Array<[string, string]>).map(([event, timestamp]) => ({
        event,
        timestamp,
      }));
    } catch (err) {
      console.warn("[distinct_id_summary] hogql failed:", err);
    }

    // 3. Recent session recordings (best-effort — may 200 with empty array
    //    if replay isn't enabled or no recordings exist).
    let recordings: unknown[] = [];
    try {
      const { data } = await posthogTeamApi<{ results?: unknown[] }>(
        c.env,
        proj.userId,
        "session_recordings/",
        { query: { distinct_id: distinctId, limit: 10 } },
      );
      recordings = data.results ?? [];
    } catch (err) {
      console.warn("[distinct_id_summary] recordings lookup failed:", err);
    }

    return c.json({
      project_id: proj.id,
      distinct_id: distinctId,
      person,
      event_stats: hogqlStats,
      recent_events: recentEvents,
      recent_recordings: recordings,
      web_ui_url: posthogWebUrl(
        c.env,
        ph.posthogProjectId,
        `persons/${encodeURIComponent(distinctId)}`,
      ),
      next_action:
        hogqlStats.count === 0
          ? "No events recorded for this distinct_id. Either the user hasn't fired any events yet, or the customer's identify() call uses a different id format."
          : `User has ${hogqlStats.count} events. ${recordings.length > 0 ? `${recordings.length} recordings available — fetch with agentry_get_session_replay(replay_id).` : "No session recordings (replay may be off or sampling skipped this user)."}`,
    });
  },
);

// ===========================================================================
// SURVEY RESPONSES — rolled up + recent free-text
// ===========================================================================

router.get(
  "/v1/projects/:project_id/surveys/:survey_id/responses",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const surveyId = c.req.param("survey_id");

    // Fetch the survey definition for question labels.
    const { teamId, data: surveyDef } = await posthogTeamApi<{
      questions?: Array<{ id?: string; type?: string; question?: string; choices?: string[] }>;
      name?: string;
    }>(c.env, proj.userId, `surveys/${encodeURIComponent(surveyId)}/`);
    const questions = surveyDef.questions ?? [];

    // Aggregate counts per response value (works for choice + rating).
    // PostHog stores each response under properties['$survey_response_<question_id>']
    // for v2+ surveys; older single-question surveys use $survey_response.
    let counts: Array<[string, number]> = [];
    let recentText: Array<{ ts: string; response: string }> = [];
    try {
      const aggResult = await runHogQl(
        c.env,
        proj.userId,
        `SELECT properties.\$survey_response AS response, count() AS n
         FROM events
         WHERE event = 'survey sent' AND properties.\$survey_id = '${escapeSqlLiteral(surveyId)}'
         GROUP BY response ORDER BY n DESC LIMIT 50`,
      );
      counts = (aggResult.results as Array<[string, number]>).filter(([r]) => r);

      // Recent free-text responses (last 100).
      const recent = await runHogQl(
        c.env,
        proj.userId,
        `SELECT timestamp, properties.\$survey_response AS response
         FROM events
         WHERE event = 'survey sent' AND properties.\$survey_id = '${escapeSqlLiteral(surveyId)}'
         ORDER BY timestamp DESC LIMIT 100`,
      );
      recentText = (recent.results as Array<[string, string]>).map(([ts, response]) => ({
        ts,
        response: typeof response === "string" ? response : JSON.stringify(response),
      }));
    } catch (err) {
      console.warn("[survey_responses] hogql failed:", err);
    }

    const total = recentText.length;
    return c.json({
      team_id: teamId,
      survey_id: surveyId,
      survey_name: surveyDef.name ?? null,
      questions: questions.map((q) => ({
        id: q.id ?? null,
        type: q.type ?? null,
        question: q.question ?? null,
        choices: q.choices ?? null,
      })),
      response_distribution: counts.map(([response, n]) => ({ response, count: n })),
      recent_responses: recentText.slice(0, 50),
      total_recent: total,
      web_ui_url: posthogWebUrl(
        c.env,
        teamId,
        `surveys/${encodeURIComponent(surveyId)}/results`,
      ),
      next_action:
        total === 0
          ? "No responses yet. If you just launched it, give it time. If it's been live a while, check appearance/targeting in the PostHog UI."
          : `${total} recent responses. Use response_distribution for counts; recent_responses for free-text/open-ended.`,
    });
  },
);

// ===========================================================================
// A/B TEST — composite tool: create multivariate feature flag + return
// the bound conversion-rate query an agent can run later.
// ===========================================================================

router.post(
  "/v1/projects/:project_id/ab-tests",
  requireApiKey(),
  async (c) => {
    ensurePosthog(c.env);
    const proj = await requireProjectAccess(c, c.req.param("project_id"));
    const body = await readJsonBody(c);
    const name = requireString(body, "name");
    const flagKey = typeof body.flag_key === "string" && body.flag_key
      ? body.flag_key
      : name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const successEvent = requireString(body, "success_event");
    const variantsInput = Array.isArray(body.variants) ? body.variants : null;
    if (!variantsInput || variantsInput.length < 2) {
      throw errors.invalidPayload({
        reason: "variants must be an array of at least 2 entries, e.g. [{key:'control'},{key:'treatment'}].",
      });
    }
    // Auto-split if rollout_percentage not given.
    const baseRollout = Math.floor(100 / variantsInput.length);
    const variants = variantsInput.map((raw, idx) => {
      const v = raw as Record<string, unknown>;
      const key = typeof v.key === "string" && v.key ? v.key : `variant_${idx}`;
      const rolloutPct =
        typeof v.rollout_percentage === "number"
          ? v.rollout_percentage
          : baseRollout + (idx === 0 ? 100 - baseRollout * variantsInput.length : 0);
      return {
        key,
        name: typeof v.name === "string" ? v.name : key,
        rollout_percentage: rolloutPct,
      };
    });
    const totalRollout = variants.reduce((a, v) => a + v.rollout_percentage, 0);
    if (totalRollout !== 100) {
      throw errors.invalidPayload({
        reason: `variants rollout_percentages must sum to 100 (got ${totalRollout}).`,
      });
    }

    // Mint the multivariate flag.
    const { teamId, data: flagData } = await posthogTeamApi<{ id?: number; key?: string }>(
      c.env,
      proj.userId,
      "feature_flags/",
      {
        method: "POST",
        body: {
          key: flagKey,
          name,
          active: true,
          filters: {
            groups: [{ properties: [], rollout_percentage: 100 }],
            multivariate: { variants },
          },
        },
      },
    );

    // Build the conversion query the agent can run via agentry_analytics_query.
    // PostHog auto-attaches $feature/<flag_key> on every event after assignment.
    const conversionQuery = `SELECT properties["$feature/${flagKey}"] AS variant, count() AS users, count(DISTINCT distinct_id) AS distinct_users\nFROM events\nWHERE event = '${successEvent.replace(/'/g, "''")}'\n  AND properties["$feature/${flagKey}"] IS NOT NULL\nGROUP BY variant\nORDER BY users DESC`;

    await audit(c, {
      userId: proj.userId,
      projectId: proj.id,
      action: "ab_test.created",
      resourceType: "ab_test",
      resourceId: flagData.id ?? null,
      summary: `Created A/B test '${name}' (flag: ${flagKey}, success: ${successEvent}, ${variants.length} variants)`,
      metadata: { flag_key: flagKey, success_event: successEvent, variants: variants.map((v) => v.key) },
    });

    return c.json({
      team_id: teamId,
      ab_test: {
        name,
        flag_id: flagData.id ?? null,
        flag_key: flagKey,
        variants,
        success_event: successEvent,
      },
      conversion_query: conversionQuery,
      web_ui_url: posthogWebUrl(c.env, teamId, `feature_flags/${flagData.id ?? ""}`),
      next_action:
        "Test created and live (active=true). Two things to wire next: " +
        `(1) instrument the customer's code to read posthog.getFeatureFlag('${flagKey}') and branch UI on the variant. ` +
        `(2) periodically run conversion_query via agentry_analytics_query to compare conversion rates between variants. ` +
        "Recommended: wait until each variant has ≥1000 users before drawing conclusions.",
    });
  },
);

// Quick'n'dirty SQL literal escape for our trusted-only use (we own the
// input — caller is api-key-authed, no SQL injection vector — but we still
// quote-escape to keep the queries valid for distinct_ids with apostrophes).
function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

export default router;
