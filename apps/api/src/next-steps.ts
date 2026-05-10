// Suggested next-step prompts the agent offers the user after install completes.
//
// Premise: the user just ran agentry_verify_install. Three signal types are
// flowing. Now what? Instead of leaving them on a blank prompt, agentry hands
// the agent a curated list of "things the user might want to do next," each with
// a paste-ready prompt template and the recipes/tools that back it.
//
// State-aware: a suggestion only appears if the prerequisites are met (e.g.
// "Build an analytics dashboard" requires PostHog configured + at least some
// events ingested).

export interface NextStep {
  id: string;
  title: string;
  /** What the user can ask Claude Code to do — paste-ready. */
  prompt_template: string;
  /** Short blurb shown alongside the title in the UI/prompt. */
  description: string;
  /** Tools / recipes the agent will use to fulfill this prompt. */
  uses: string[];
  /** Roughly how long the agent will take to produce the answer. */
  estimated_seconds: number;
  /**
   * Predicate keys that must all be true for this suggestion to appear.
   * Evaluated by the API against project state before returning.
   */
  requires: NextStepRequirement[];
  /**
   * Marks suggestions that aren't fully implemented yet. The agent should still
   * surface these, but flag them as "coming soon" so the user knows.
   */
  status?: "available" | "preview" | "coming_soon";
}

export type NextStepRequirement =
  | "always"
  | "analytics_configured"   // PostHog env vars set
  | "has_events"              // at least one analytics event captured
  | "has_cases"               // at least one error case
  | "has_deploys"             // at least one deploy recorded
  | "install_verified";       // verify_install passed

export const NEXT_STEPS: NextStep[] = [
  {
    id: "build_analytics_dashboard",
    title: "Build a customized analytics dashboard",
    description:
      "Walk me through DAU, top events, signup-to-conversion funnel, " +
      "and weekly retention — formatted as markdown tables and ASCII charts in chat.",
    prompt_template:
      "Build me an analytics dashboard for the last 14 days. Include daily active " +
      "users, top 10 events by frequency, my signup funnel (page_view → signup_completed), " +
      "and weekly retention by cohort. Render each as a markdown table with a short narrative.",
    uses: [
      "agentry_run_recipe(active_users_daily)",
      "agentry_run_recipe(top_events_30d)",
      "agentry_run_recipe(funnel_3_step)",
      "agentry_run_recipe(weekly_retention)",
    ],
    estimated_seconds: 30,
    requires: ["analytics_configured", "has_events"],
  },
  {
    id: "build_error_dashboard",
    title: "Build an error monitoring dashboard",
    description:
      "Show top open errors, errors per hour, and anything that broke after the latest deploy. " +
      "For each top error, suggest a fix.",
    prompt_template:
      "Build me an error monitoring dashboard. Show: top 10 open cases by event_count, " +
      "errors per hour for the last 24h, and any cases that started after my latest deploy. " +
      "For each of the top 3 cases, fetch the case detail and propose a fix.",
    uses: [
      "agentry_run_recipe(open_cases_top)",
      "agentry_run_recipe(errors_by_hour_24h)",
      "agentry_run_recipe(errors_after_last_deploy)",
      "agentry_get_case (per top case)",
    ],
    estimated_seconds: 60,
    requires: ["has_cases"],
  },
  {
    id: "deploy_health_check",
    title: "Deploy health check",
    description:
      "How often we ship + did the last deploy break anything?",
    prompt_template:
      "Run a deploy health check: show deploy frequency for the last 30 days and list any " +
      "cases that started after the most recent deploy. If anything looks suspicious, " +
      "open the relevant case and walk me through the diagnosis.",
    uses: [
      "agentry_run_recipe(deploy_frequency_30d)",
      "agentry_run_recipe(errors_after_last_deploy)",
      "agentry_get_case (if regressions found)",
    ],
    estimated_seconds: 45,
    requires: ["has_deploys"],
  },
  {
    id: "investigate_top_error",
    title: "Investigate my biggest current bug",
    description:
      "Pick the most-frequent open error, fetch its full context, and walk through a fix.",
    prompt_template:
      "Find my most-frequent open case (highest event_count), fetch its detail, cross-reference " +
      "with recent_deploys to find the regression, and propose a fix in the relevant file. " +
      "If you can produce a confident patch, write it; otherwise summarize what's needed.",
    uses: [
      "agentry_run_recipe(open_cases_top)",
      "agentry_get_case",
      "(local file edits)",
    ],
    estimated_seconds: 90,
    requires: ["has_cases"],
  },
  {
    id: "review_signup_funnel",
    title: "Review my signup funnel for drop-offs",
    description:
      "Compute drop-off % at each step and call out the biggest leak.",
    prompt_template:
      "Compute drop-off percentages for my signup funnel: page_view → signup_started → " +
      "signup_completed for the last 30 days. Identify the biggest drop and suggest 2-3 " +
      "hypotheses for why users abandon at that step.",
    uses: ["agentry_run_recipe(funnel_3_step)"],
    estimated_seconds: 30,
    requires: ["analytics_configured", "has_events"],
  },
  {
    id: "compare_versions",
    title: "Compare metrics across deploys",
    description:
      "Did the most recent deploy improve or regress conversions?",
    prompt_template:
      "Compare my conversion rate (signup_completed → checkout_completed) for the 7 days " +
      "before vs after the most recent deploy. Show the numbers and tell me whether the " +
      "deploy moved the needle.",
    uses: [
      "agentry_run_recipe(conversion_rate)",
      "agentry_list_deploys",
      "agentry_analytics_query (custom date-bracketed comparison)",
    ],
    estimated_seconds: 45,
    requires: ["analytics_configured", "has_events", "has_deploys"],
  },
  {
    id: "weekly_review",
    title: "Generate this week's review post",
    description:
      "A digest covering active users, top events, top errors, deploys, and what changed " +
      "vs last week — paste-ready for Slack or a team standup.",
    prompt_template:
      "Generate this week's review: DAU trend, top 5 events, top 3 open errors, deploys " +
      "shipped, and notable funnel changes vs last week. Format as a Slack-friendly markdown " +
      "post with bullet points and a one-sentence headline summary at the top.",
    uses: [
      "agentry_run_recipe(active_users_daily)",
      "agentry_run_recipe(top_events_30d)",
      "agentry_run_recipe(open_cases_top)",
      "agentry_list_deploys",
    ],
    estimated_seconds: 90,
    requires: ["install_verified"],
  },
  {
    id: "auto_fix_on_error",
    title: "Set up automated fix-on-error",
    description:
      "When a new error case lands, auto-spawn a Claude session that investigates and opens a PR. " +
      "(Requires webhooks — currently in development; the agent can poll instead today.)",
    prompt_template:
      "Set up automated fix-on-error: every 10 minutes, poll agentry_list_cases for new cases " +
      "since the last check, and for each one call agentry_get_case + propose a fix as a draft PR.",
    uses: [
      "agentry_list_cases (with cursor)",
      "agentry_get_case",
      "(scheduled task or local cron + git tooling)",
    ],
    estimated_seconds: 120,
    requires: ["has_cases"],
    status: "preview",
  },
];

export function selectApplicableNextSteps(state: {
  analytics_configured: boolean;
  has_events: boolean;
  has_cases: boolean;
  has_deploys: boolean;
  install_verified: boolean;
}): NextStep[] {
  return NEXT_STEPS.filter((s) =>
    s.requires.every((req) => {
      if (req === "always") return true;
      return Boolean(state[req as keyof typeof state]);
    }),
  );
}
