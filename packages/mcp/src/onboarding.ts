// Compute structured onboarding hints for the agent.
// agentry_status pipes this through; tools also return individual hints.

import type { AgentryConfig } from "@agentry/shared";

export type OnboardingState = "no_key" | "no_project" | "ready";

export interface OnboardingHint {
  state: OnboardingState;
  next_tool: string | null;
  next_action: string;
  message: string;
}

export function getOnboardingHint(cfg: AgentryConfig): OnboardingHint {
  if (!cfg.api_key) {
    return {
      state: "no_key",
      next_tool: "agentry_signup",
      next_action:
        "Ask the user for their email, then call `agentry_signup` with it. " +
        "v0 has no email verification — the same email can be re-signed up to recover a lost key.",
      message:
        "No API key on file. The next step is to call `agentry_signup` with the user's email.",
    };
  }
  const projectIds = Object.keys(cfg.projects);
  if (projectIds.length === 0 || !cfg.default_project_id) {
    return {
      state: "no_project",
      next_tool: "agentry_create_project",
      next_action:
        "Ask the user for a project name (and optionally repo_url + local_path of the repo), " +
        "then call `agentry_create_project`. The response includes the DSN and SDK install snippet.",
      message:
        "API key on file, but no project yet. Call `agentry_create_project` to mint a DSN.",
    };
  }
  return {
    state: "ready",
    next_tool: "agentry_list_cases",
    next_action:
      "Onboarding done. Call `agentry_list_cases` to see open errors, or " +
      "`agentry_capture_test_event` to verify ingest end-to-end.",
    message: "Set up — API key + at least one project. Ready to investigate cases.",
  };
}
