// Compute structured onboarding hints for the agent.
// agentry_status pipes this through; tools also return individual hints.

import type { AgentryConfig } from "@agentrysh/shared";

export type OnboardingState = "no_key" | "no_project" | "needs_install" | "ready";

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
      next_tool: "agentry_login",
      next_action:
        "Call `agentry_login`. It returns a verification URL and a short user_code; " +
        "ask the user to open the URL in their browser and paste the code. " +
        "The tool blocks until GitHub authorizes (~30s), then persists the api_key locally.",
      message:
        "No API key on file. Call `agentry_login` to authenticate via GitHub (no email or password required).",
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
  // After project creation, the SDK isn't installed yet in the customer's app.
  // We don't know for sure — but we lean on a local marker. If install_verified
  // hasn't been set on any project, treat as needs_install.
  const anyVerified = projectIds.some((id) => cfg.projects[id]?.install_verified === true);
  if (!anyVerified) {
    return {
      state: "needs_install",
      next_tool: "agentry_install_guide",
      next_action:
        "Project created, but the SDK isn't proven installed yet. " +
        "Call `agentry_install_guide` for the comprehensive checklist, walk through it, then call " +
        "`agentry_verify_install` — that's how we know errors, analytics, and deploys are actually flowing.",
      message: "Project ready, but install hasn't been verified. Run agentry_install_guide → agentry_verify_install.",
    };
  }
  return {
    state: "ready",
    next_tool: "agentry_list_cases",
    next_action:
      "Onboarding done. Call `agentry_list_cases` to see open errors, or " +
      "`agentry_analytics_query` to investigate funnels.",
    message: "Set up — install verified, signals flowing. Ready to investigate.",
  };
}
