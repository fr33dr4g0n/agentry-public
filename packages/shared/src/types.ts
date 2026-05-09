// Cross-package type contracts. KEEP STABLE — three packages depend on this.

export interface StackFrame {
  filename?: string | null;
  function?: string | null;
  lineno?: number | null;
  colno?: number | null;
  in_app?: boolean | null;
  context_line?: string | null;
}

export interface IngestEventPayload {
  // Sentry-compatible enough that real Sentry SDKs work without modification.
  event_id?: string;
  timestamp?: number; // unix seconds
  platform?: string;
  environment?: string;
  release?: string;          // we map this to deploy_sha if deploy_sha not set
  deploy_sha?: string;       // agentry extension
  server_name?: string;
  level?: "fatal" | "error" | "warning" | "info" | "debug";
  message?: string | { formatted?: string; message?: string };
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      stacktrace?: { frames?: StackFrame[] };
    }>;
  };
  breadcrumbs?: { values?: Array<Record<string, unknown>> };
  request?: Record<string, unknown>;
  user?: Record<string, unknown>;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  // Allow forward-compat fields without rejecting:
  [k: string]: unknown;
}

export type CaseStatus = "open" | "investigating" | "resolved" | "spurious" | "ignored";
export type SuppressionAction = "auto_ignore" | "auto_resolve" | "prompt_hint";

export interface CaseSummary {
  id: string;
  project_id: string;
  fingerprint: string;
  error_type: string;
  message: string;
  status: CaseStatus;
  event_count: number;
  first_seen_at: number;
  last_seen_at: number;
  last_deploy_sha: string | null;
  agent_summary: string | null;
  pr_url: string | null;
}

export interface CaseDetail extends CaseSummary {
  recent_events: Array<{
    id: string;
    received_at: number;
    deploy_sha: string | null;
    environment: string | null;
    message: string;
    stack: StackFrame[];
  }>;
  suppression_hints: Array<{
    id: string;
    action: SuppressionAction;
    pattern: string;
    hint_text: string | null;
    reason: string | null;
  }>;
  local_path: string | null;   // populated by MCP client from local config
  next_actions: string[];      // hints for the agent
}

export interface AgentryConfig {
  server_url: string;
  api_key: string | null;
  default_project_id: string | null;
  projects: Record<string, AgentryProjectConfig>;
}

export interface AgentryProjectConfig {
  id: string;
  name: string;
  dsn: string;
  local_path: string | null;
  default_branch: string;
}
