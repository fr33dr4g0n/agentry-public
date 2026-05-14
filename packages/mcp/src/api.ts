// Thin HTTP client for the agentry API.
// All errors propagate the structured `next_action` field so the MCP layer can
// surface it back to the calling agent verbatim.

import type {
  AgentryConfig,
  CaseDetail,
  CaseStatus,
  CaseSummary,
  IngestEventPayload,
  RecordAgentRunRequest,
  RecordSuppressionRequest,
} from "@agentrysh/shared";

export interface ApiError extends Error {
  status: number;
  code: string;
  next_action?: string;
  details?: Record<string, unknown>;
}

export interface LoginResponse {
  status: "ok";
  api_key: string;
  user_id: string;
  prefix: string;
  github?: {
    id: number;
    username: string;
    email: string | null;
    avatar_url: string | null;
  };
  next_action?: string;
}

export interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  next_action?: string;
}

export type DevicePollResponse =
  | LoginResponse
  | { status: "pending"; next_action?: string }
  | { status: "slow_down"; next_action?: string }
  | { status: "expired"; next_action?: string }
  | { status: "denied"; next_action?: string };

export interface ProjectSummary {
  id: string;
  name: string;
  repo_url: string | null;
  default_branch: string;
  created_at: number;
}

export interface ProjectDetail extends ProjectSummary {
  dsn?: string; // returned on create only
}

export interface CreateProjectResponse {
  id: string;
  name: string;
  dsn: string;
  // First-party typed endpoints — what new MCP code should use.
  logs_url?: string;
  analytics_url?: string;
  deploys_url?: string;
  default_branch?: string;
  install_snippet?: string;
  next_action?: string;
}

export interface InstallSnippet {
  language: string;
  code: string;
  env_vars: Record<string, string>;
}

function buildError(status: number, body: unknown): ApiError {
  const b = (body ?? {}) as { error?: { code?: string; message?: string; next_action?: string; details?: Record<string, unknown> } };
  const inner = b.error ?? {};
  const err = new Error(inner.message ?? `HTTP ${status}`) as ApiError;
  err.status = status;
  err.code = inner.code ?? `http_${status}`;
  if (inner.next_action) err.next_action = inner.next_action;
  if (inner.details) err.details = inner.details;
  return err;
}

interface FetchOpts {
  method?: string;
  body?: unknown;
  // Use a DSN's public key as auth instead of bearer api_key (for ingest)
  dsnAuth?: string;
  // Skip Authorization header entirely
  skipAuth?: boolean;
  // Override base url (for ingest endpoint URL building)
  absoluteUrl?: string;
}

export async function apiFetch<T>(
  cfg: AgentryConfig,
  pathOrUrl: string,
  opts: FetchOpts = {}
): Promise<T> {
  const url = opts.absoluteUrl ?? `${cfg.server_url.replace(/\/$/, "")}${pathOrUrl}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "agentry-mcp/0.0.4",
  };
  if (!opts.skipAuth) {
    if (opts.dsnAuth) {
      headers["x-sentry-auth"] =
        `Sentry sentry_version=7, sentry_key=${opts.dsnAuth}, sentry_client=agentry-mcp/0.0.4`;
    } else if (cfg.api_key) {
      headers["authorization"] = `Bearer ${cfg.api_key}`;
    }
  }
  const res = await fetch(url, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON body — leave undefined
    }
  }
  if (!res.ok) throw buildError(res.status, parsed);
  return parsed as T;
}

// Endpoint helpers — keeping the shape narrow so it's obvious from a single
// reading which routes the MCP server depends on.

export const api = {
  startDeviceFlow(cfg: AgentryConfig): Promise<DeviceStartResponse> {
    return apiFetch<DeviceStartResponse>(cfg, "/v1/auth/device", {
      method: "POST",
      body: {},
      skipAuth: true,
    });
  },
  pollDeviceFlow(cfg: AgentryConfig, deviceCode: string): Promise<DevicePollResponse> {
    return apiFetch<DevicePollResponse>(cfg, "/v1/auth/device/poll", {
      method: "POST",
      body: { device_code: deviceCode },
      skipAuth: true,
    });
  },
  testLogin(cfg: AgentryConfig, email: string): Promise<LoginResponse> {
    return apiFetch<LoginResponse>(cfg, "/v1/auth/_test/login", {
      method: "POST",
      body: { email },
      skipAuth: true,
    });
  },
  rotateKey(cfg: AgentryConfig): Promise<LoginResponse> {
    return apiFetch<LoginResponse>(cfg, "/v1/auth/keys/rotate", {
      method: "POST",
      body: {},
    });
  },
  listProjects(cfg: AgentryConfig): Promise<{ projects: ProjectSummary[] }> {
    return apiFetch<{ projects: ProjectSummary[] }>(cfg, "/v1/projects");
  },
  createProject(
    cfg: AgentryConfig,
    body: { name: string; repo_url?: string; default_branch?: string; local_path?: string }
  ): Promise<CreateProjectResponse> {
    return apiFetch<CreateProjectResponse>(cfg, "/v1/projects", { body });
  },
  getProject(cfg: AgentryConfig, id: string): Promise<ProjectDetail> {
    return apiFetch<ProjectDetail>(cfg, `/v1/projects/${encodeURIComponent(id)}`);
  },
  listCases(
    cfg: AgentryConfig,
    projectId: string,
    status?: CaseStatus
  ): Promise<{ cases: CaseSummary[] }> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    return apiFetch<{ cases: CaseSummary[] }>(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/cases${qs}`
    );
  },
  getCase(cfg: AgentryConfig, caseId: string): Promise<CaseDetail> {
    return apiFetch<CaseDetail>(cfg, `/v1/cases/${encodeURIComponent(caseId)}`);
  },
  updateCase(
    cfg: AgentryConfig,
    caseId: string,
    body: { status?: CaseStatus; agent_summary?: string; pr_url?: string }
  ): Promise<CaseDetail> {
    return apiFetch<CaseDetail>(cfg, `/v1/cases/${encodeURIComponent(caseId)}`, {
      method: "PATCH",
      body,
    });
  },
  recordAgentRun(
    cfg: AgentryConfig,
    caseId: string,
    body: Omit<RecordAgentRunRequest, "case_id">
  ): Promise<{ id: string }> {
    return apiFetch<{ id: string }>(
      cfg,
      `/v1/cases/${encodeURIComponent(caseId)}/runs`,
      { body }
    );
  },
  recordSuppression(
    cfg: AgentryConfig,
    projectId: string,
    body: RecordSuppressionRequest
  ): Promise<{ id: string }> {
    return apiFetch<{ id: string }>(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/suppressions`,
      { body }
    );
  },
  getInstallSnippet(cfg: AgentryConfig, language: string): Promise<InstallSnippet> {
    return apiFetch<InstallSnippet>(
      cfg,
      `/v1/install/sdk/${encodeURIComponent(language)}`,
      { skipAuth: true }
    );
  },
  // Log ingest. A log with name/message/stack (or a Sentry-shape exception)
  // gets fingerprinted and rolled into a Case. Uses DSN as auth (Bearer or
  // x-sentry-auth header). /v1/store/ remains as a Sentry-protocol drop-in.
  storeEvent(
    cfg: AgentryConfig,
    projectId: string,
    publicKey: string,
    event: IngestEventPayload
  ): Promise<{ id: string; case_id?: string }> {
    return apiFetch<{ id: string; case_id?: string }>(cfg, "", {
      absoluteUrl: `${cfg.server_url.replace(/\/$/, "")}/v1/logs/${encodeURIComponent(projectId)}/`,
      method: "POST",
      body: event,
      dsnAuth: publicKey,
    });
  },

  // Deploys: ingest with DSN auth, list with API-key auth.
  recordDeploy(
    cfg: AgentryConfig,
    projectId: string,
    publicKey: string,
    body: { sha: string; branch?: string; environment?: string; message?: string; url?: string; actor?: string }
  ): Promise<{ id: string; received_at: number }> {
    return apiFetch<{ id: string; received_at: number }>(cfg, "", {
      absoluteUrl: `${cfg.server_url.replace(/\/$/, "")}/v1/deploys/${encodeURIComponent(projectId)}/`,
      method: "POST",
      body,
      dsnAuth: publicKey,
    });
  },
  listDeploys(
    cfg: AgentryConfig,
    projectId: string,
    opts?: { limit?: number; since?: number }
  ): Promise<{ deploys: Array<Record<string, unknown>> }> {
    const qs = [
      opts?.limit ? `limit=${encodeURIComponent(opts.limit)}` : null,
      opts?.since ? `since=${encodeURIComponent(opts.since)}` : null,
    ].filter(Boolean).join("&");
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/deploys${qs ? "?" + qs : ""}`,
    );
  },

  // Analytics: forward an event (DSN-auth, hits PostHog via the agentry proxy).
  // First-party path is /v1/analytics/; /v1/track/ remains a PostHog-shaped alias.
  trackEvent(
    cfg: AgentryConfig,
    projectId: string,
    publicKey: string,
    body: { event: string; distinct_id?: string; properties?: Record<string, unknown> }
  ): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(cfg, "", {
      absoluteUrl: `${cfg.server_url.replace(/\/$/, "")}/v1/analytics/${encodeURIComponent(projectId)}/`,
      method: "POST",
      body,
      dsnAuth: publicKey,
    });
  },
  // Analytics queries (HogQL passthrough, api-key auth).
  analyticsQuery(
    cfg: AgentryConfig,
    projectId: string,
    query: string,
  ): Promise<{ results: unknown[]; columns: string[] | null; types: string[] | null }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/analytics/query`,
      { method: "POST", body: { query } },
    );
  },

  // Comprehensive install guide.
  getInstallGuide(
    cfg: AgentryConfig,
    framework: string,
  ): Promise<InstallGuide> {
    return apiFetch<InstallGuide>(
      cfg,
      `/v1/install/guide?framework=${encodeURIComponent(framework)}`,
      { skipAuth: true },
    );
  },
  listRecipes(cfg: AgentryConfig, category?: string): Promise<{
    count: number;
    categories: string[];
    recipes: Array<Record<string, unknown>>;
  }> {
    const qs = category ? `?category=${encodeURIComponent(category)}` : "";
    return apiFetch(cfg, `/v1/recipes${qs}`, { skipAuth: true });
  },
  getRecipe(cfg: AgentryConfig, id: string): Promise<Record<string, unknown>> {
    return apiFetch(cfg, `/v1/recipes/${encodeURIComponent(id)}`, { skipAuth: true });
  },
  runRecipe(
    cfg: AgentryConfig,
    projectId: string,
    recipeId: string,
    params: Record<string, unknown>,
  ): Promise<{
    recipe_id: string;
    title: string;
    backend: "analytics" | "cases";
    rows: Array<Record<string, unknown>>;
    columns: string[];
    render_hint: Record<string, unknown>;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/recipes/${encodeURIComponent(recipeId)}/run`,
      { method: "POST", body: { params } },
    );
  },
  getQueryDocs(cfg: AgentryConfig): Promise<string> {
    // Returns markdown text directly.
    const url = `${cfg.server_url.replace(/\/$/, "")}/v1/docs/query`;
    return fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`docs fetch ${res.status}`);
      return res.text();
    });
  },
  getNextSteps(cfg: AgentryConfig, projectId: string): Promise<{
    project_state: Record<string, boolean>;
    count: number;
    suggestions: Array<Record<string, unknown>>;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/next-steps`,
    );
  },
  // Webhooks
  registerWebhook(
    cfg: AgentryConfig,
    projectId: string,
    body: { url: string; events?: string[]; description?: string },
  ): Promise<{
    id: string;
    url: string;
    events: string[];
    signing_secret: string;
    signing_secret_prefix: string;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/webhooks`,
      { method: "POST", body },
    );
  },
  listWebhooks(cfg: AgentryConfig, projectId: string): Promise<{
    webhooks: Array<Record<string, unknown>>;
  }> {
    return apiFetch(cfg, `/v1/projects/${encodeURIComponent(projectId)}/webhooks`);
  },
  deleteWebhook(cfg: AgentryConfig, projectId: string, id: string): Promise<{ ok: boolean }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/webhooks/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
  testWebhook(cfg: AgentryConfig, projectId: string, id: string): Promise<{ ok: boolean }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/webhooks/${encodeURIComponent(id)}/test`,
      { method: "POST", body: {} },
    );
  },
  getAutomationDocs(cfg: AgentryConfig): Promise<string> {
    const url = `${cfg.server_url.replace(/\/$/, "")}/v1/docs/automation`;
    return fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`docs fetch ${res.status}`);
      return res.text();
    });
  },
  // Project health
  getProjectHealth(cfg: AgentryConfig, projectId: string): Promise<Record<string, unknown>> {
    return apiFetch(cfg, `/v1/projects/${encodeURIComponent(projectId)}/health`);
  },
  // Alerts
  createAlert(
    cfg: AgentryConfig,
    projectId: string,
    body: {
      name: string;
      recipe_id: string;
      threshold_column: string;
      threshold_op: string;
      threshold_value: number | string;
      params?: Record<string, unknown>;
      description?: string;
      webhook_id?: string;
    },
  ): Promise<{ id: string; name: string; recipe_id: string }> {
    return apiFetch(cfg, `/v1/projects/${encodeURIComponent(projectId)}/alerts`, {
      method: "POST",
      body,
    });
  },
  listAlerts(cfg: AgentryConfig, projectId: string): Promise<{ alerts: Array<Record<string, unknown>> }> {
    return apiFetch(cfg, `/v1/projects/${encodeURIComponent(projectId)}/alerts`);
  },
  deleteAlert(cfg: AgentryConfig, projectId: string, id: string): Promise<{ ok: boolean }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
  evaluateAlert(cfg: AgentryConfig, projectId: string, id: string): Promise<Record<string, unknown>> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(id)}/evaluate`,
      { method: "POST", body: {} },
    );
  },
  // Agent-filed feedback.
  sendFeedback(
    cfg: AgentryConfig,
    body: {
      kind: "missing_feature" | "bug" | "ux_friction" | "other";
      message: string;
      agent_note?: string;
      tool_name?: string;
      attempt_count?: number;
      project_id?: string;
      claude_session_id?: string;
    },
  ): Promise<{ id: string; received_at: number; next_action?: string }> {
    return apiFetch(cfg, "/v1/feedback", { method: "POST", body });
  },
  listFeedback(
    cfg: AgentryConfig,
    opts?: { limit?: number; kind?: string; resolved?: boolean },
  ): Promise<{ count: number; feedback: Array<Record<string, unknown>>; next_action?: string }> {
    const qs = [
      opts?.limit ? `limit=${encodeURIComponent(opts.limit)}` : null,
      opts?.kind ? `kind=${encodeURIComponent(opts.kind)}` : null,
      typeof opts?.resolved === "boolean" ? `resolved=${opts.resolved}` : null,
    ].filter(Boolean).join("&");
    return apiFetch(cfg, `/v1/feedback${qs ? "?" + qs : ""}`);
  },
  // Discovery of subscribable event names (server-emitted + recent analytics).
  listEventNames(
    cfg: AgentryConfig,
    projectId: string,
  ): Promise<{
    server_emitted: string[];
    analytics_events: Array<{ event: string; count: number; last_seen: number }>;
    wildcards: string[];
    next_action?: string;
  }> {
    return apiFetch(cfg, `/v1/projects/${encodeURIComponent(projectId)}/event-names`);
  },
};

export interface InstallGuideStep {
  id: string;
  title: string;
  why: string;
  action: "run" | "edit" | "verify" | "manual";
  file_hint?: string;
  command?: string;
  code?: string;
  validate: string;
}

export interface InstallGuide {
  framework: string;
  signal_types: string[];
  steps: InstallGuideStep[];
  pitfalls: string[];
  signal_health_principles: string[];
  next_action: string;
}
