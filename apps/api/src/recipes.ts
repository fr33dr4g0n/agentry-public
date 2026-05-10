// Recipe catalog: canonical query templates for the most-asked questions.
//
// Premise: agentry has no dashboard. Instead, the user's Claude Code asks
// natural-language questions ("how many users do we have by cohort?", "show me
// the signup funnel with drop-offs") and runs a recipe that returns rows + a
// render_hint. The agent assembles a markdown table, ASCII bar chart, or
// Mermaid diagram in chat.
//
// Two backends:
//   - "analytics"  → HogQL query against the user's PostHog project
//   - "cases"      → SQL against agentry's own DB (errors / deploys / cases)

export type RecipeBackend = "analytics" | "cases";

export interface RecipeParam {
  name: string;
  type: "string" | "number";
  description: string;
  default: string | number;
  required?: boolean;
}

export interface RenderHint {
  type: "table" | "line" | "bar" | "funnel" | "scalar" | "stacked_bar";
  /** Column or field for the X axis / categorical key. */
  x?: string;
  /** Column for Y axis / value. */
  y?: string;
  /** For funnels: ordered list of column names (counts at each step). */
  stages?: string[];
  /** Short title the agent should use as the chart title. */
  title: string;
  /** What the agent should remind the user of in their explanation. */
  notes?: string[];
}

export interface Recipe {
  id: string;
  category:
    | "users"
    | "funnels"
    | "events"
    | "errors"
    | "deploys"
    | "retention";
  title: string;
  description: string;
  backend: RecipeBackend;
  params: RecipeParam[];
  /** HogQL template. {{paramName}} placeholders are interpolated server-side. */
  query: string;
  expected_columns: string[];
  render_hint: RenderHint;
  example_user_question: string;
}

export const RECIPES: Recipe[] = [
  // ---------- USERS ----------
  {
    id: "active_users_daily",
    category: "users",
    title: "Daily Active Users (last N days)",
    description: "Count of unique distinct_ids per day from analytics events.",
    backend: "analytics",
    params: [
      { name: "days", type: "number", description: "Lookback window in days", default: 14 },
    ],
    query: `SELECT toDate(timestamp) AS day, count(DISTINCT distinct_id) AS dau
FROM events
WHERE timestamp > now() - INTERVAL {{days}} DAY
GROUP BY day
ORDER BY day`,
    expected_columns: ["day", "dau"],
    render_hint: {
      type: "line",
      x: "day",
      y: "dau",
      title: "Daily Active Users",
      notes: ["DAU counts unique distinct_id per day. Anonymous users count if they generated any event."],
    },
    example_user_question: "how many active users did we have each day this week?",
  },
  {
    id: "users_by_cohort_signup_week",
    category: "users",
    title: "Users by signup-week cohort",
    description: "Groups users by the week they first signed up; useful for cohort sizing.",
    backend: "analytics",
    params: [
      { name: "weeks", type: "number", description: "Lookback in weeks", default: 12 },
      { name: "signup_event", type: "string", description: "The event that marks signup", default: "signup_completed" },
    ],
    query: `SELECT
  toMonday(toDate(min_timestamp)) AS cohort_week,
  count() AS users
FROM (
  SELECT distinct_id, min(timestamp) AS min_timestamp
  FROM events
  WHERE event = '{{signup_event}}'
    AND timestamp > now() - INTERVAL {{weeks}} WEEK
  GROUP BY distinct_id
)
GROUP BY cohort_week
ORDER BY cohort_week`,
    expected_columns: ["cohort_week", "users"],
    render_hint: {
      type: "bar",
      x: "cohort_week",
      y: "users",
      title: "New users per signup-week cohort",
    },
    example_user_question: "show me users grouped by the week they signed up",
  },

  // ---------- RETENTION ----------
  {
    id: "weekly_retention",
    category: "retention",
    title: "Weekly retention by signup cohort",
    description:
      "For each signup-week cohort, the % of users who returned in week 1, 2, 3, …",
    backend: "analytics",
    params: [
      { name: "weeks", type: "number", description: "How many cohort weeks to compute", default: 8 },
      { name: "signup_event", type: "string", description: "Cohort-defining event", default: "signup_completed" },
    ],
    query: `WITH signups AS (
  SELECT distinct_id, toMonday(toDate(min(timestamp))) AS cohort
  FROM events
  WHERE event = '{{signup_event}}'
    AND timestamp > now() - INTERVAL {{weeks}} WEEK
  GROUP BY distinct_id
),
activity AS (
  SELECT distinct_id, toMonday(toDate(timestamp)) AS active_week
  FROM events
  WHERE timestamp > now() - INTERVAL {{weeks}} WEEK
  GROUP BY distinct_id, active_week
)
SELECT
  s.cohort AS cohort_week,
  dateDiff('week', s.cohort, a.active_week) AS week_offset,
  count(DISTINCT s.distinct_id) AS retained_users
FROM signups s
JOIN activity a ON s.distinct_id = a.distinct_id
WHERE a.active_week >= s.cohort
GROUP BY cohort_week, week_offset
ORDER BY cohort_week, week_offset`,
    expected_columns: ["cohort_week", "week_offset", "retained_users"],
    render_hint: {
      type: "stacked_bar",
      x: "cohort_week",
      y: "retained_users",
      title: "Weekly retention by cohort",
      notes: [
        "week_offset=0 is the cohort itself. Higher offsets show retention drop-off.",
        "Render as a triangle/cohort heatmap if your UI supports it; markdown table is fine otherwise.",
      ],
    },
    example_user_question: "what does our weekly retention look like by cohort?",
  },

  // ---------- FUNNELS ----------
  {
    id: "funnel_3_step",
    category: "funnels",
    title: "3-step funnel with drop-offs",
    description:
      "Counts users who fired step1, then step2 (after step1), then step3 (after step2). " +
      "Drop-off % between each step is computed by the agent from the returned counts.",
    backend: "analytics",
    params: [
      { name: "step1", type: "string", description: "First event (entry)", default: "page_view" },
      { name: "step2", type: "string", description: "Second event", default: "signup_started" },
      { name: "step3", type: "string", description: "Third event (conversion)", default: "signup_completed" },
      { name: "days", type: "number", description: "Lookback window in days", default: 30 },
    ],
    query: `WITH s1 AS (
  SELECT distinct_id, min(timestamp) AS t1
  FROM events
  WHERE event = '{{step1}}' AND timestamp > now() - INTERVAL {{days}} DAY
  GROUP BY distinct_id
),
s2 AS (
  SELECT e.distinct_id, min(e.timestamp) AS t2
  FROM events e
  JOIN s1 ON s1.distinct_id = e.distinct_id
  WHERE e.event = '{{step2}}' AND e.timestamp >= s1.t1
  GROUP BY e.distinct_id
),
s3 AS (
  SELECT e.distinct_id, min(e.timestamp) AS t3
  FROM events e
  JOIN s2 ON s2.distinct_id = e.distinct_id
  WHERE e.event = '{{step3}}' AND e.timestamp >= s2.t2
  GROUP BY e.distinct_id
)
SELECT
  (SELECT count() FROM s1) AS step1_count,
  (SELECT count() FROM s2) AS step2_count,
  (SELECT count() FROM s3) AS step3_count`,
    expected_columns: ["step1_count", "step2_count", "step3_count"],
    render_hint: {
      type: "funnel",
      stages: ["step1_count", "step2_count", "step3_count"],
      title: "3-step funnel",
      notes: [
        "Compute drop-off % from the returned counts: drop_n = 1 - (step_n+1 / step_n).",
        "Render as a 3-row table (step name, count, drop-off %) or an ASCII funnel.",
      ],
    },
    example_user_question: "what's the drop-off in our signup funnel?",
  },

  // ---------- EVENTS ----------
  {
    id: "top_events_30d",
    category: "events",
    title: "Top events by frequency (last N days)",
    description: "Most-fired event names — useful for understanding what your users actually do.",
    backend: "analytics",
    params: [
      { name: "days", type: "number", description: "Lookback in days", default: 30 },
      { name: "limit", type: "number", description: "Max rows", default: 20 },
    ],
    query: `SELECT event, count() AS occurrences
FROM events
WHERE timestamp > now() - INTERVAL {{days}} DAY
GROUP BY event
ORDER BY occurrences DESC
LIMIT {{limit}}`,
    expected_columns: ["event", "occurrences"],
    render_hint: {
      type: "bar",
      x: "event",
      y: "occurrences",
      title: "Top events by frequency",
    },
    example_user_question: "what events do my users fire most?",
  },
  {
    id: "event_count_per_day",
    category: "events",
    title: "Daily count of a specific event",
    description: "Time-series count of one event by day — for tracking growth or regressions.",
    backend: "analytics",
    params: [
      { name: "event_name", type: "string", description: "The event to count", default: "checkout_completed", required: true },
      { name: "days", type: "number", description: "Lookback in days", default: 30 },
    ],
    query: `SELECT toDate(timestamp) AS day, count() AS occurrences
FROM events
WHERE event = '{{event_name}}'
  AND timestamp > now() - INTERVAL {{days}} DAY
GROUP BY day
ORDER BY day`,
    expected_columns: ["day", "occurrences"],
    render_hint: {
      type: "line",
      x: "day",
      y: "occurrences",
      title: "Daily count",
    },
    example_user_question: "how many checkouts did we have each day last month?",
  },
  {
    id: "conversion_rate",
    category: "events",
    title: "Conversion rate from event A to event B",
    description:
      "% of users who fired event A in the lookback window who later fired event B.",
    backend: "analytics",
    params: [
      { name: "event_a", type: "string", description: "Entry event", default: "signup_completed", required: true },
      { name: "event_b", type: "string", description: "Conversion event", default: "checkout_completed", required: true },
      { name: "days", type: "number", description: "Lookback window", default: 30 },
    ],
    query: `WITH a AS (
  SELECT distinct_id FROM events
  WHERE event = '{{event_a}}' AND timestamp > now() - INTERVAL {{days}} DAY
  GROUP BY distinct_id
),
b AS (
  SELECT distinct_id FROM events
  WHERE event = '{{event_b}}' AND distinct_id IN (SELECT distinct_id FROM a)
  GROUP BY distinct_id
)
SELECT
  (SELECT count() FROM a) AS users_a,
  (SELECT count() FROM b) AS users_b,
  round(100.0 * (SELECT count() FROM b) / nullif((SELECT count() FROM a), 0), 2) AS conversion_pct`,
    expected_columns: ["users_a", "users_b", "conversion_pct"],
    render_hint: {
      type: "scalar",
      title: "Conversion rate",
      notes: ["Render as: 'X of Y users (Z%) converted from event_a to event_b.'"],
    },
    example_user_question: "what % of signups end up paying?",
  },

  // ---------- ERRORS (cases backend) ----------
  {
    id: "open_cases_top",
    category: "errors",
    title: "Top open cases by event count",
    description: "Most-frequent unresolved errors right now.",
    backend: "cases",
    params: [
      { name: "limit", type: "number", description: "Max rows", default: 10 },
    ],
    query: `SELECT id, error_type, message, event_count, last_seen_at, last_deploy_sha
FROM cases
WHERE project_id = :project_id AND status = 'open'
ORDER BY event_count DESC
LIMIT :limit`,
    expected_columns: ["id", "error_type", "message", "event_count", "last_seen_at", "last_deploy_sha"],
    render_hint: {
      type: "table",
      title: "Top open cases",
      notes: ["For each case, agent should call agentry_get_case for the stack trace and proposed fix."],
    },
    example_user_question: "what are my worst current bugs?",
  },
  {
    id: "errors_by_hour_24h",
    category: "errors",
    title: "Errors per hour (last 24h)",
    description: "Time-series of new error events bucketed by hour.",
    backend: "cases",
    params: [],
    query: `SELECT
  (received_at / 3600) * 3600 AS hour,
  count() AS errors
FROM events
WHERE project_id = :project_id
  AND received_at > unixepoch() - 86400
GROUP BY hour
ORDER BY hour`,
    expected_columns: ["hour", "errors"],
    render_hint: {
      type: "line",
      x: "hour",
      y: "errors",
      title: "Errors per hour, last 24h",
      notes: ["hour is unix-seconds; agent should format as HH:00."],
    },
    example_user_question: "are errors spiking right now?",
  },
  {
    id: "errors_after_last_deploy",
    category: "errors",
    title: "Cases that started after the most recent deploy",
    description:
      "Useful for 'did we ship a bug?' — lists cases first seen after the latest deploy timestamp.",
    backend: "cases",
    params: [],
    query: `WITH latest_deploy AS (
  SELECT max(received_at) AS deploy_ts FROM deploys WHERE project_id = :project_id
)
SELECT id, error_type, message, event_count, first_seen_at, last_deploy_sha
FROM cases
WHERE project_id = :project_id
  AND first_seen_at >= (SELECT deploy_ts FROM latest_deploy)
ORDER BY first_seen_at DESC`,
    expected_columns: ["id", "error_type", "message", "event_count", "first_seen_at", "last_deploy_sha"],
    render_hint: {
      type: "table",
      title: "Cases since latest deploy",
      notes: [
        "If the table is non-empty, the latest deploy probably introduced these.",
        "Agent should follow up with agentry_get_case for each to propose a fix.",
      ],
    },
    example_user_question: "did the last deploy break anything?",
  },

  // ---------- USER IDENTIFICATION (cases-backend) ----------
  {
    id: "top_users_by_errors",
    category: "users",
    title: "Top users by error count (last N days)",
    description: "Which identified users are hitting the most errors? Useful for outreach or user-specific debugging.",
    backend: "cases",
    params: [
      { name: "days", type: "number", description: "Lookback in days", default: 7 },
      { name: "limit", type: "number", description: "Max users", default: 25 },
    ],
    query: `SELECT user_id, max(user_email) AS user_email, count(*) AS error_count,
       count(DISTINCT fingerprint) AS distinct_fingerprints, max(received_at) AS last_seen_at
FROM events
WHERE project_id = :project_id AND user_id IS NOT NULL AND received_at > :since
GROUP BY user_id ORDER BY error_count DESC LIMIT :limit`,
    expected_columns: ["user_id", "user_email", "error_count", "distinct_fingerprints", "last_seen_at"],
    render_hint: {
      type: "table",
      title: "Top users by error count",
      notes: [
        "High error_count + 1 distinct_fingerprint = one bug is very loud for that user.",
        "High distinct_fingerprints = wider regression for that user — check their env/account/version.",
      ],
    },
    example_user_question: "which users are hitting the most errors right now?",
  },
  {
    id: "unique_users_24h",
    category: "users",
    title: "Unique identified users with errors in last 24h",
    description: "How many distinct users were affected today?",
    backend: "cases",
    params: [],
    query: `SELECT count(DISTINCT user_id) AS unique_users, count(*) AS total_events
FROM events
WHERE project_id = :project_id
  AND user_id IS NOT NULL
  AND received_at > unixepoch() - 86400`,
    expected_columns: ["unique_users", "total_events"],
    render_hint: {
      type: "scalar",
      title: "Affected users (last 24h)",
      notes: ["Render as: 'X distinct users hit Y errors in the last 24h.'"],
    },
    example_user_question: "how many users were affected today?",
  },
  {
    id: "users_affected_by_case",
    category: "users",
    title: "Users affected by a specific case",
    description: "List of distinct user_ids that hit the case's fingerprint, with error_count and last_seen.",
    backend: "cases",
    params: [
      { name: "fingerprint", type: "string", description: "Fingerprint of the case (from agentry_get_case)", default: "", required: true },
      { name: "limit", type: "number", description: "Max users", default: 50 },
    ],
    query: `SELECT user_id, max(user_email) AS user_email, count(*) AS error_count, max(received_at) AS last_seen_at
FROM events
WHERE project_id = :project_id AND fingerprint = :fingerprint AND user_id IS NOT NULL
GROUP BY user_id ORDER BY last_seen_at DESC LIMIT :limit`,
    expected_columns: ["user_id", "user_email", "error_count", "last_seen_at"],
    render_hint: {
      type: "table",
      title: "Users affected by case",
    },
    example_user_question: "who's been hit by this bug?",
  },

  // ---------- DEPLOYS ----------
  {
    id: "deploy_frequency_30d",
    category: "deploys",
    title: "Deploys per day (last 30 days)",
    description: "How often we ship. Useful baseline metric.",
    backend: "cases",
    params: [],
    query: `SELECT
  date(received_at, 'unixepoch') AS day,
  count() AS deploys
FROM deploys
WHERE project_id = :project_id
  AND received_at > unixepoch() - 30 * 86400
GROUP BY day
ORDER BY day`,
    expected_columns: ["day", "deploys"],
    render_hint: {
      type: "bar",
      x: "day",
      y: "deploys",
      title: "Deploys per day",
    },
    example_user_question: "how often do we ship?",
  },
];

export function getRecipe(id: string): Recipe | null {
  return RECIPES.find((r) => r.id === id) ?? null;
}

export function listRecipes(category?: string): Recipe[] {
  if (!category) return RECIPES;
  return RECIPES.filter((r) => r.category === category);
}

// Interpolate {{name}} HogQL placeholders. Validates against `params` so a
// malicious input can't sneak through unexpected substitutions.
export function interpolateQuery(
  template: string,
  params: Record<string, unknown>,
  defs: RecipeParam[],
): string {
  let out = template;
  for (const def of defs) {
    const provided = params[def.name];
    const value = provided !== undefined && provided !== null ? provided : def.default;
    const stringValue = typeof value === "number" ? String(value) : escapeHogQL(String(value));
    out = out.replaceAll(`{{${def.name}}}`, stringValue);
  }
  return out;
}

function escapeHogQL(s: string): string {
  // HogQL string literals — escape single quotes and backslashes.
  // Keep paranoid since this is concatenated into SQL.
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
