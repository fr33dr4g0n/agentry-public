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
} from "@agentry/shared";

export interface ApiError extends Error {
  status: number;
  code: string;
  next_action?: string;
  details?: Record<string, unknown>;
}

export interface SignupResponse {
  api_key: string;
  user_id: string;
  prefix: string;
  next_action?: string;
}

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
  default_branch: string;
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
    "user-agent": "agentry-mcp/0.0.1",
  };
  if (!opts.skipAuth) {
    if (opts.dsnAuth) {
      headers["x-sentry-auth"] =
        `Sentry sentry_version=7, sentry_key=${opts.dsnAuth}, sentry_client=agentry-mcp/0.0.1`;
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
  signup(cfg: AgentryConfig, email: string): Promise<SignupResponse> {
    return apiFetch<SignupResponse>(cfg, "/v1/auth/signup", {
      body: { email },
      skipAuth: true,
    });
  },
  rotateKey(cfg: AgentryConfig): Promise<SignupResponse> {
    return apiFetch<SignupResponse>(cfg, "/v1/auth/keys/rotate", {
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
  // Sentry-protocol ingest. Uses DSN public key as auth via x-sentry-auth header.
  // The store endpoint URL embeds the project id and the host comes from the DSN.
  storeEvent(
    cfg: AgentryConfig,
    projectId: string,
    publicKey: string,
    event: IngestEventPayload
  ): Promise<{ id: string; case_id?: string }> {
    return apiFetch<{ id: string; case_id?: string }>(cfg, "", {
      absoluteUrl: `${cfg.server_url.replace(/\/$/, "")}/v1/store/${encodeURIComponent(projectId)}/`,
      method: "POST",
      body: event,
      dsnAuth: publicKey,
    });
  },
};
