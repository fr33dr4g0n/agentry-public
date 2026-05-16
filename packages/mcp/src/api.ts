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
  /** Public dashboard key (agp_…). Returned on first login or first login
   *  after the migration that added the kind=public row. May be a redacted
   *  placeholder if the user already had a public key (rotate via
   *  agentry_rotate_public_key — coming). */
  public_api_key?: string;
  public_api_key_prefix?: string;
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
    "user-agent": "agentry-mcp/0.0.11",
  };
  if (!opts.skipAuth) {
    if (opts.dsnAuth) {
      headers["x-sentry-auth"] =
        `Sentry sentry_version=7, sentry_key=${opts.dsnAuth}, sentry_client=agentry-mcp/0.0.11`;
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
  // Public-fetchable recipe publications. Owner-side; api-key auth.
  publishQuery(
    cfg: AgentryConfig,
    projectId: string,
    body: { recipe_id: string; params?: Record<string, unknown>; description?: string },
  ): Promise<{
    id: string;
    project_id: string;
    recipe_id: string;
    params: Record<string, unknown>;
    description: string | null;
    public_url: string;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/public-queries`,
      { body },
    );
  },
  listPublications(
    cfg: AgentryConfig,
    projectId: string,
  ): Promise<{
    project_id: string;
    count: number;
    publications: Array<{
      id: string;
      recipe_id: string;
      params: Record<string, unknown> | undefined;
      description: string | null;
      created_at: number;
      last_used_at: number | null;
      public_url: string;
    }>;
  }> {
    return apiFetch(cfg, `/v1/projects/${encodeURIComponent(projectId)}/public-queries`);
  },
  revokePublication(
    cfg: AgentryConfig,
    projectId: string,
    publicationId: string,
  ): Promise<{ id: string; revoked: boolean; next_action: string }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/public-queries/${encodeURIComponent(publicationId)}`,
      { method: "DELETE" },
    );
  },
  // PostHog per-user feature config: session replay today, more coming as
  // master Personal API Key scopes expand.
  configureSessionReplay(
    cfg: AgentryConfig,
    projectId: string,
    body: {
      strategy: "off" | "all" | "sampled" | "url_scoped" | "errors_only";
      sample_rate?: number;
      retention_days?: number;
      min_duration_ms?: number;
      url_triggers?: Array<{ url: string; matching?: "exact" | "regex" }>;
    },
  ): Promise<{
    team_id: number;
    strategy: string;
    settings: Record<string, unknown>;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/posthog/session-replay/configure`,
      { body },
    );
  },
  getSessionReplayStatus(
    cfg: AgentryConfig,
    projectId: string,
  ): Promise<{
    team_id: number;
    session_recording_opt_in: boolean | null;
    session_recording_sample_rate: string | null;
    session_recording_retention_period: string | null;
    web_ui_url: string;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/posthog/session-replay/status`,
    );
  },
  // --- PostHog per-user-team CRUD: feature flags, cohorts, surveys, replays.
  // All endpoints wrap PostHog's REST API behind the master Personal API Key
  // + per-user team_id (server-side enforced). Master-key scope expansion
  // landed 2026-05-15; before that these returned 403.
  listFeatureFlags(
    cfg: AgentryConfig,
    projectId: string,
    opts: { limit?: number } = {},
  ): Promise<{
    team_id: number;
    flags: Array<Record<string, unknown>>;
    count: number;
    web_ui_url: string;
    next_action: string;
  }> {
    const qs = opts.limit ? `?limit=${opts.limit}` : "";
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/feature-flags${qs}`,
    );
  },
  getFeatureFlag(
    cfg: AgentryConfig,
    projectId: string,
    flagId: string,
  ): Promise<{ team_id: number; flag: Record<string, unknown>; web_ui_url: string }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/feature-flags/${encodeURIComponent(flagId)}`,
    );
  },
  createFeatureFlag(
    cfg: AgentryConfig,
    projectId: string,
    body: {
      key: string;
      name?: string;
      active?: boolean;
      rollout_percentage?: number;
      filters?: Record<string, unknown>;
    },
  ): Promise<{
    team_id: number;
    flag: Record<string, unknown>;
    web_ui_url: string;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/feature-flags`,
      { body },
    );
  },
  updateFeatureFlag(
    cfg: AgentryConfig,
    projectId: string,
    flagId: string,
    body: {
      active?: boolean;
      name?: string;
      rollout_percentage?: number;
      filters?: Record<string, unknown>;
    },
  ): Promise<{ team_id: number; flag: Record<string, unknown> }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/feature-flags/${encodeURIComponent(flagId)}`,
      { method: "PATCH", body },
    );
  },
  deleteFeatureFlag(
    cfg: AgentryConfig,
    projectId: string,
    flagId: string,
  ): Promise<{ team_id: number; deleted: string; soft: boolean }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/feature-flags/${encodeURIComponent(flagId)}`,
      { method: "DELETE" },
    );
  },
  listCohorts(
    cfg: AgentryConfig,
    projectId: string,
  ): Promise<{
    team_id: number;
    cohorts: Array<Record<string, unknown>>;
    count: number;
    web_ui_url: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/cohorts`,
    );
  },
  getCohort(
    cfg: AgentryConfig,
    projectId: string,
    cohortId: string,
  ): Promise<{ team_id: number; cohort: Record<string, unknown>; web_ui_url: string }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/cohorts/${encodeURIComponent(cohortId)}`,
    );
  },
  createCohort(
    cfg: AgentryConfig,
    projectId: string,
    body:
      | { name: string; event: string; days?: number }
      | { name: string; groups: Array<Record<string, unknown>> },
  ): Promise<{
    team_id: number;
    cohort: Record<string, unknown>;
    web_ui_url: string;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/cohorts`,
      { body },
    );
  },
  deleteCohort(
    cfg: AgentryConfig,
    projectId: string,
    cohortId: string,
  ): Promise<{ team_id: number; deleted: string; soft: boolean }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/cohorts/${encodeURIComponent(cohortId)}`,
      { method: "DELETE" },
    );
  },
  listSurveys(
    cfg: AgentryConfig,
    projectId: string,
  ): Promise<{
    team_id: number;
    surveys: Array<Record<string, unknown>>;
    count: number;
    web_ui_url: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/surveys`,
    );
  },
  getSurvey(
    cfg: AgentryConfig,
    projectId: string,
    surveyId: string,
  ): Promise<{
    team_id: number;
    survey: Record<string, unknown>;
    web_ui_url: string;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/surveys/${encodeURIComponent(surveyId)}`,
    );
  },
  createSurvey(
    cfg: AgentryConfig,
    projectId: string,
    body: {
      name: string;
      type?: "popover" | "widget" | "button" | "api";
      question?: string;
      question_type?: "open" | "rating" | "single_choice" | "multiple_choice" | "link";
      questions?: Array<Record<string, unknown>>;
      description?: string;
      linked_flag_id?: number;
      targeting_flag_id?: number;
      conditions?: Record<string, unknown>;
      appearance?: Record<string, unknown>;
      start_date?: string;
    },
  ): Promise<{
    team_id: number;
    survey: Record<string, unknown>;
    web_ui_url: string;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/surveys`,
      { body },
    );
  },
  deleteSurvey(
    cfg: AgentryConfig,
    projectId: string,
    surveyId: string,
  ): Promise<{ team_id: number; deleted: string }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/surveys/${encodeURIComponent(surveyId)}`,
      { method: "DELETE" },
    );
  },
  listSessionReplays(
    cfg: AgentryConfig,
    projectId: string,
    opts: { distinctId?: string; dateFrom?: string; dateTo?: string; limit?: number } = {},
  ): Promise<{
    team_id: number;
    recordings: Array<Record<string, unknown>>;
    has_next: boolean;
    web_ui_url: string;
    next_action: string;
  }> {
    const params = new URLSearchParams();
    if (opts.distinctId) params.set("distinct_id", opts.distinctId);
    if (opts.dateFrom) params.set("date_from", opts.dateFrom);
    if (opts.dateTo) params.set("date_to", opts.dateTo);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/session-replays${qs}`,
    );
  },
  getSessionReplay(
    cfg: AgentryConfig,
    projectId: string,
    replayId: string,
  ): Promise<{
    team_id: number;
    recording: Record<string, unknown>;
    player_url: string;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/session-replays/${encodeURIComponent(replayId)}`,
    );
  },
  getReplaySnapshots(
    cfg: AgentryConfig,
    projectId: string,
    replayId: string,
    source?: "realtime" | "blob",
  ): Promise<{
    team_id: number;
    replay_id: string;
    snapshots: unknown;
    next_action: string;
  }> {
    const qs = source ? `?source=${source}` : "";
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/session-replays/${encodeURIComponent(replayId)}/snapshots${qs}`,
    );
  },
  evaluateFeatureFlag(
    cfg: AgentryConfig,
    projectId: string,
    body: {
      distinct_id: string;
      key?: string;
      person_properties?: Record<string, unknown>;
      groups?: Record<string, string>;
    },
  ): Promise<{
    team_id: number;
    distinct_id: string;
    key?: string;
    value?: boolean | string | null;
    payload?: unknown;
    flags?: Record<string, boolean | string>;
    payloads?: Record<string, unknown>;
    enabled_count?: number;
    next_action?: string | null;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/feature-flags/evaluate`,
      { body },
    );
  },
  getDistinctIdSummary(
    cfg: AgentryConfig,
    projectId: string,
    distinctId: string,
  ): Promise<{
    project_id: string;
    distinct_id: string;
    person: unknown;
    event_stats: { count: number; first_seen: string | null; last_seen: string | null };
    recent_events: Array<{ event: string; timestamp: string }>;
    recent_recordings: unknown[];
    web_ui_url: string;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(distinctId)}/summary`,
    );
  },
  getSurveyResponses(
    cfg: AgentryConfig,
    projectId: string,
    surveyId: string,
  ): Promise<{
    team_id: number;
    survey_id: string;
    survey_name: string | null;
    questions: Array<Record<string, unknown>>;
    response_distribution: Array<{ response: string; count: number }>;
    recent_responses: Array<{ ts: string; response: string }>;
    total_recent: number;
    web_ui_url: string;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/surveys/${encodeURIComponent(surveyId)}/responses`,
    );
  },
  createAbTest(
    cfg: AgentryConfig,
    projectId: string,
    body: {
      name: string;
      flag_key?: string;
      success_event: string;
      variants: Array<{ key?: string; name?: string; rollout_percentage?: number }>;
    },
  ): Promise<{
    team_id: number;
    ab_test: Record<string, unknown>;
    conversion_query: string;
    web_ui_url: string;
    next_action: string;
  }> {
    return apiFetch(
      cfg,
      `/v1/projects/${encodeURIComponent(projectId)}/ab-tests`,
      { body },
    );
  },
  listRecentChanges(
    cfg: AgentryConfig,
    opts: {
      hours?: number;
      actionPrefix?: string;
      resourceType?: string;
      projectId?: string;
      limit?: number;
    } = {},
  ): Promise<{
    hours: number;
    since: number;
    count: number;
    actions: Array<{
      id: string;
      at: number;
      action: string;
      resource_type: string;
      resource_id: string | null;
      project_id: string | null;
      summary: string | null;
      ip: string | null;
      ua: string | null;
      metadata: unknown;
    }>;
    next_action: string;
  }> {
    const params = new URLSearchParams();
    if (opts.hours !== undefined) params.set("hours", String(opts.hours));
    if (opts.actionPrefix) params.set("action_prefix", opts.actionPrefix);
    if (opts.resourceType) params.set("resource_type", opts.resourceType);
    if (opts.projectId) params.set("project_id", opts.projectId);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiFetch(cfg, `/v1/audit/recent${qs}`);
  },
  // Idempotent recovery for first-login PostHog provisioning failures. If
  // PostHog was 503 at the moment the user logged in, the api_key was minted
  // but no analytics backend was attached → every /v1/track/ 503s with
  // "user has no PostHog project provisioned". This call re-runs the
  // provisioning step without re-running the GitHub device flow.
  repairAnalyticsBackend(
    cfg: AgentryConfig,
  ): Promise<{
    provisioned: boolean;
    posthog_project_id: number | null;
    already_existed?: boolean;
    error?: string;
    reason?: string;
    next_action: string;
  }> {
    return apiFetch(cfg, "/v1/auth/posthog/provision", { body: {} });
  },
  getInstallSnippet(cfg: AgentryConfig, language: string): Promise<InstallSnippet> {
    return apiFetch<InstallSnippet>(
      cfg,
      `/v1/install/sdk/${encodeURIComponent(language)}`,
      { skipAuth: true }
    );
  },
  // Fetch a raw .map blob for local translation. Auth is DSN (Bearer) — same
  // key as ingest. The agent then runs @jridgewell/trace-mapping against the
  // blob to translate minified frames. agentry never translates server-side.
  async getSourcemapBlob(
    cfg: AgentryConfig,
    projectId: string,
    publicKey: string,
    opts: { releaseId?: string; sourceUrl: string }
  ): Promise<string | null> {
    const baseUrl = cfg.server_url.replace(/\/$/, "");
    const qs = new URLSearchParams({
      source_url: opts.sourceUrl,
      ...(opts.releaseId ? { release_id: opts.releaseId } : {}),
    });
    const url = `${baseUrl}/v1/sourcemaps/${encodeURIComponent(projectId)}/blob?${qs}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${publicKey}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(
        `getSourcemapBlob failed: ${res.status} ${await res.text()}`
      );
    }
    return await res.text();
  },
  // Upload a sourcemap blob. Auth is the project's DSN (same key as ingest).
  // The `body` is the raw .map JSON; the API stores it under (project_id,
  // release_id, source_url) for later retrieval via getSourcemapBlob.
  async uploadSourcemap(
    cfg: AgentryConfig,
    projectId: string,
    publicKey: string,
    opts: { releaseId?: string; sourceUrl: string; body: string }
  ): Promise<{
    id: string;
    project_id: string;
    release_id: string;
    source_url: string;
    size_bytes: number;
  }> {
    const baseUrl = cfg.server_url.replace(/\/$/, "");
    const qs = new URLSearchParams({
      source_url: opts.sourceUrl,
      ...(opts.releaseId ? { release_id: opts.releaseId } : {}),
    });
    const url = `${baseUrl}/v1/sourcemaps/${encodeURIComponent(projectId)}/?${qs}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${publicKey}`,
        "content-type": "application/json",
        "user-agent": "agentry-mcp/0.0.11",
      },
      body: opts.body,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) throw buildError(res.status, parsed);
    return parsed as Awaited<ReturnType<typeof api.uploadSourcemap>>;
  },
  async listSourcemaps(
    cfg: AgentryConfig,
    projectId: string,
    publicKey: string,
    opts: { releaseId?: string } = {}
  ): Promise<{
    project_id: string;
    count: number;
    sourcemaps: Array<{
      id: string;
      release_id: string;
      source_url: string;
      size_bytes: number;
      uploaded_at: number;
    }>;
  }> {
    const baseUrl = cfg.server_url.replace(/\/$/, "");
    const qs = opts.releaseId ? `?release_id=${encodeURIComponent(opts.releaseId)}` : "";
    const url = `${baseUrl}/v1/sourcemaps/${encodeURIComponent(projectId)}/${qs}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${publicKey}` },
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) throw buildError(res.status, parsed);
    return parsed as Awaited<ReturnType<typeof api.listSourcemaps>>;
  },
  async deleteSourcemaps(
    cfg: AgentryConfig,
    projectId: string,
    publicKey: string,
    opts: { releaseId: string }
  ): Promise<{ project_id: string; release_id: string; deleted: number }> {
    const baseUrl = cfg.server_url.replace(/\/$/, "");
    const url =
      `${baseUrl}/v1/sourcemaps/${encodeURIComponent(projectId)}/` +
      `?release_id=${encodeURIComponent(opts.releaseId)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${publicKey}` },
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) throw buildError(res.status, parsed);
    return parsed as Awaited<ReturnType<typeof api.deleteSourcemaps>>;
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
