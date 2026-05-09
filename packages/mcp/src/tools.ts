// MCP tool definitions + dispatch.
// Each tool's response is shaped to give the calling agent enough context to
// choose its next action without re-asking the user.

import type { AgentryConfig, AgentryProjectConfig } from "@agentry/shared";
import { parseDsn } from "@agentry/shared";
import { api, type ApiError } from "./api.js";
import { loadConfig, saveConfig } from "./config.js";
import { getOnboardingHint } from "./onboarding.js";

// MCP tool descriptor (matches @modelcontextprotocol/sdk shape).
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "agentry_status",
    description:
      "Show what's set up locally and what to do next. Always safe to call. " +
      "Use this first if you don't know whether the user has signed up or has a project.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agentry_signup",
    description:
      "Sign the user up by email. Returns an API key and stores it locally. " +
      "v0 has no email verification — the same email can be re-signed up to recover a lost key.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "User's email address" },
      },
      required: ["email"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_recover",
    description:
      "Recover access by re-signing up with the same email. Mints a fresh API key " +
      "and stores it locally. Use this when the user has lost their key.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "User's email address" },
      },
      required: ["email"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_rotate_key",
    description:
      "Rotate the current API key. The old key is revoked. The new one is stored locally.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agentry_list_projects",
    description:
      "List all projects belonging to the authenticated user. " +
      "Each entry is enriched with `local_path` from local config so the agent knows where to `cd`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agentry_create_project",
    description:
      "Create a new project. Returns the DSN and SDK install snippet ready to paste. " +
      "Pass `local_path` (the absolute path to the repo on disk) so future cases route back to the right directory.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name (e.g. 'musicvideogen-prod')" },
        repo_url: { type: "string", description: "Optional git URL (e.g. https://github.com/user/repo)" },
        local_path: { type: "string", description: "Absolute filesystem path to the repo on disk" },
        default_branch: { type: "string", description: "Default branch (defaults to 'main')" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_install_sdk",
    description:
      "Get the SDK install snippet for a language. Returns code + env vars the user should paste into their app.",
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description: "Language target. Defaults to 'node' (the only supported option in v0).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_list_cases",
    description:
      "List error cases for a project. Defaults to the local default project + status='open'. " +
      "Each entry is enriched with `local_path` so the agent knows where to `cd` to investigate.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project id. If omitted, uses the local default project.",
        },
        status: {
          type: "string",
          enum: ["open", "investigating", "resolved", "spurious", "ignored"],
          description: "Filter by status. Defaults to 'open'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_get_case",
    description:
      "Get full detail for a case — stack trace, deploy SHA, suppression hints, and `local_path`. " +
      "Surface `next_actions` to the agent.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string", description: "Case id" },
      },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_resolve_case",
    description:
      "Mark a case as resolved. Pass an optional summary and PR url so the team has audit trail.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        summary: { type: "string", description: "Short markdown summary of the fix" },
        pr_url: { type: "string", description: "PR URL if you opened one" },
      },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_mark_spurious",
    description:
      "Mark a case as spurious (not a real bug). Optionally provide `suppress_pattern` and a reason; " +
      "if set, also records a suppression rule so future matching events are auto-ignored.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        reason: { type: "string", description: "Why this is noise" },
        suppress_pattern: {
          type: "string",
          description:
            "Optional fingerprint pattern (substring or regex starting with '/') to auto-ignore future matches",
        },
      },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_record_suppression",
    description:
      "Record a noise-suppression rule for a project. Matches future events by fingerprint pattern. " +
      "Actions: 'auto_ignore' (drop), 'auto_resolve' (mark resolved silently), 'prompt_hint' (attach hint to case).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project id. If omitted, uses the local default project.",
        },
        fingerprint_pattern: {
          type: "string",
          description: "Substring match by default; regex if it starts with '/'",
        },
        action: {
          type: "string",
          enum: ["auto_ignore", "auto_resolve", "prompt_hint"],
        },
        reason: { type: "string" },
        hint_text: {
          type: "string",
          description: "Required when action is 'prompt_hint' — the hint surfaced via agentry_get_case",
        },
      },
      required: ["fingerprint_pattern", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_capture_test_event",
    description:
      "Fire a synthetic Sentry-shaped event at the project's ingest endpoint to verify ingest works end-to-end. " +
      "Returns the event id and (if the API surfaces it) the case id so you can immediately call agentry_get_case.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project id. If omitted, uses the local default project.",
        },
      },
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers shared across tool handlers
// ---------------------------------------------------------------------------

function summarizeApiError(err: unknown): {
  error: { code: string; message: string; next_action?: string; details?: unknown };
} {
  if (err && typeof err === "object" && "code" in err && "status" in err) {
    const e = err as ApiError;
    return {
      error: {
        code: e.code,
        message: e.message,
        ...(e.next_action ? { next_action: e.next_action } : {}),
        ...(e.details ? { details: e.details } : {}),
      },
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    error: {
      code: "client_error",
      message: msg,
      next_action:
        "This was a local/MCP-side error, not an API error. Check `agentry_status` and try again.",
    },
  };
}

function pickProject(
  cfg: AgentryConfig,
  projectId: string | undefined
): { id: string; project: AgentryProjectConfig | null } | null {
  const id = projectId ?? cfg.default_project_id;
  if (!id) return null;
  const project = cfg.projects[id] ?? null;
  return { id, project };
}

function projectByLookup(cfg: AgentryConfig, projectId: string): AgentryProjectConfig | null {
  return cfg.projects[projectId] ?? null;
}

function persistKeyResponse(
  cfg: AgentryConfig,
  resp: { api_key: string; user_id: string; prefix: string }
): AgentryConfig {
  const next: AgentryConfig = {
    ...cfg,
    api_key: resp.api_key,
  };
  saveConfig(next);
  return next;
}

// Build a Sentry-shaped synthetic event suitable for hitting /v1/store/:id/.
function buildSyntheticEvent(): Record<string, unknown> {
  const eventId = `agentrytest-${Date.now().toString(36)}`;
  return {
    event_id: eventId,
    timestamp: Math.floor(Date.now() / 1000),
    platform: "node",
    level: "error",
    environment: "agentry-mcp-test",
    release: "agentry-mcp-test",
    message: "Synthetic test event from agentry_capture_test_event",
    exception: {
      values: [
        {
          type: "AgentryTestError",
          value: "This is a synthetic event triggered from the agentry MCP server.",
          stacktrace: {
            frames: [
              {
                filename: "agentry-mcp/src/tools.ts",
                function: "agentry_capture_test_event",
                lineno: 1,
                in_app: true,
              },
            ],
          },
        },
      ],
    },
    tags: { synthetic: "true" },
  };
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

export interface ToolResult {
  // The MCP server wraps this in a content block (text JSON) before sending.
  [k: string]: unknown;
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<ToolResult> {
  const a = args ?? {};
  try {
    switch (name) {
      case "agentry_status":
        return handleStatus();
      case "agentry_signup":
        return await handleSignup(String(a.email ?? ""));
      case "agentry_recover":
        return await handleSignup(String(a.email ?? ""), true);
      case "agentry_rotate_key":
        return await handleRotateKey();
      case "agentry_list_projects":
        return await handleListProjects();
      case "agentry_create_project":
        return await handleCreateProject({
          name: String(a.name ?? ""),
          repo_url: a.repo_url ? String(a.repo_url) : undefined,
          local_path: a.local_path ? String(a.local_path) : undefined,
          default_branch: a.default_branch ? String(a.default_branch) : undefined,
        });
      case "agentry_install_sdk":
        return await handleInstallSdk(a.language ? String(a.language) : "node");
      case "agentry_list_cases":
        return await handleListCases({
          project_id: a.project_id ? String(a.project_id) : undefined,
          status: a.status ? (String(a.status) as never) : undefined,
        });
      case "agentry_get_case":
        return await handleGetCase(String(a.case_id ?? ""));
      case "agentry_resolve_case":
        return await handleResolveCase({
          case_id: String(a.case_id ?? ""),
          summary: a.summary ? String(a.summary) : undefined,
          pr_url: a.pr_url ? String(a.pr_url) : undefined,
        });
      case "agentry_mark_spurious":
        return await handleMarkSpurious({
          case_id: String(a.case_id ?? ""),
          reason: a.reason ? String(a.reason) : undefined,
          suppress_pattern: a.suppress_pattern ? String(a.suppress_pattern) : undefined,
        });
      case "agentry_record_suppression":
        return await handleRecordSuppression({
          project_id: a.project_id ? String(a.project_id) : undefined,
          fingerprint_pattern: String(a.fingerprint_pattern ?? ""),
          action: String(a.action ?? "") as never,
          reason: a.reason ? String(a.reason) : undefined,
          hint_text: a.hint_text ? String(a.hint_text) : undefined,
        });
      case "agentry_capture_test_event":
        return await handleCaptureTestEvent(a.project_id ? String(a.project_id) : undefined);
      default:
        return {
          error: {
            code: "unknown_tool",
            message: `Unknown tool: ${name}`,
            next_action: "Call ListTools to see available tools.",
          },
        };
    }
  } catch (err) {
    return summarizeApiError(err);
  }
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function handleStatus(): ToolResult {
  const cfg = loadConfig();
  const hint = getOnboardingHint(cfg);
  const projectIds = Object.keys(cfg.projects);
  return {
    server_url: cfg.server_url,
    has_api_key: Boolean(cfg.api_key),
    api_key_prefix: cfg.api_key ? `${cfg.api_key.slice(0, 8)}…` : null,
    default_project_id: cfg.default_project_id,
    project_count: projectIds.length,
    projects: projectIds.map((id) => {
      const p = cfg.projects[id]!;
      return { id, name: p.name, local_path: p.local_path };
    }),
    onboarding: hint,
    next_steps: [hint.message, hint.next_action],
  };
}

async function handleSignup(email: string, recovery = false): Promise<ToolResult> {
  if (!email) {
    return {
      error: {
        code: "missing_email",
        message: "email is required",
        next_action: "Ask the user for their email, then call this tool again.",
      },
    };
  }
  const cfg = loadConfig();
  const resp = await api.signup(cfg, email);
  const next = persistKeyResponse(cfg, resp);
  return {
    ok: true,
    recovery,
    user_id: resp.user_id,
    api_key_prefix: resp.prefix,
    persisted_to: "local config",
    server_url: next.server_url,
    next_action:
      resp.next_action ??
      "Key stored locally. Next: call `agentry_create_project` with a project name and the repo's local_path.",
  };
}

async function handleRotateKey(): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: {
        code: "no_key",
        message: "No API key to rotate.",
        next_action:
          "Call `agentry_signup` with the user's email to mint one. (`agentry_recover` is the same flow if they had one previously.)",
      },
    };
  }
  const resp = await api.rotateKey(cfg);
  persistKeyResponse(cfg, resp);
  return {
    ok: true,
    user_id: resp.user_id,
    api_key_prefix: resp.prefix,
    next_action:
      resp.next_action ??
      "New key stored locally. Old key is revoked — update any places it was pasted (CI envs, etc).",
  };
}

async function handleListProjects(): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: {
        code: "no_key",
        message: "No API key on file.",
        next_action: "Call `agentry_signup` first.",
      },
    };
  }
  const resp = await api.listProjects(cfg);
  const enriched = resp.projects.map((p) => {
    const local = cfg.projects[p.id];
    return {
      ...p,
      local_path: local?.local_path ?? null,
      dsn_known_locally: Boolean(local?.dsn),
      is_default: cfg.default_project_id === p.id,
    };
  });
  return {
    projects: enriched,
    default_project_id: cfg.default_project_id,
    next_action:
      enriched.length === 0
        ? "No projects yet. Call `agentry_create_project` to make one."
        : "Pick a project and call `agentry_list_cases` to see open errors.",
  };
}

async function handleCreateProject(input: {
  name: string;
  repo_url?: string;
  local_path?: string;
  default_branch?: string;
}): Promise<ToolResult> {
  if (!input.name) {
    return {
      error: {
        code: "missing_name",
        message: "name is required",
        next_action: "Ask the user for a project name.",
      },
    };
  }
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: {
        code: "no_key",
        message: "No API key on file.",
        next_action: "Call `agentry_signup` first.",
      },
    };
  }
  const resp = await api.createProject(cfg, {
    name: input.name,
    repo_url: input.repo_url,
    local_path: input.local_path,
    default_branch: input.default_branch,
  });
  // Persist DSN + local_path locally so subsequent tool calls can route back.
  const projectConfig: AgentryProjectConfig = {
    id: resp.id,
    name: resp.name,
    dsn: resp.dsn,
    local_path: input.local_path ?? null,
    default_branch: resp.default_branch ?? input.default_branch ?? "main",
  };
  const nextCfg: AgentryConfig = {
    ...cfg,
    default_project_id: cfg.default_project_id ?? resp.id,
    projects: { ...cfg.projects, [resp.id]: projectConfig },
  };
  saveConfig(nextCfg);

  // Try to also pull the install snippet so the agent has it without a second roundtrip.
  let install: { language: string; code: string; env_vars: Record<string, string> } | null = null;
  try {
    install = await api.getInstallSnippet(cfg, "node");
  } catch {
    // Non-fatal — the agent can call agentry_install_sdk separately.
  }

  return {
    ok: true,
    project: {
      id: resp.id,
      name: resp.name,
      dsn: resp.dsn,
      default_branch: projectConfig.default_branch,
      local_path: projectConfig.local_path,
    },
    install_snippet: install,
    next_action:
      resp.next_action ??
      "DSN stored locally. Paste the install snippet into the app, set AGENTRY_DSN, then call `agentry_capture_test_event` to verify ingest.",
  };
}

async function handleInstallSdk(language: string): Promise<ToolResult> {
  const cfg = loadConfig();
  const resp = await api.getInstallSnippet(cfg, language);
  return {
    language: resp.language,
    code: resp.code,
    env_vars: resp.env_vars,
    next_action:
      "Paste `code` into the user's project, then set the env_vars (AGENTRY_DSN especially). " +
      "Then call `agentry_capture_test_event` to verify ingest.",
  };
}

async function handleListCases(input: {
  project_id?: string;
  status?: "open" | "investigating" | "resolved" | "spurious" | "ignored";
}): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: {
        code: "no_key",
        message: "No API key on file.",
        next_action: "Call `agentry_signup` first.",
      },
    };
  }
  const picked = pickProject(cfg, input.project_id);
  if (!picked) {
    return {
      error: {
        code: "no_project",
        message: "No project_id given and no default project set.",
        next_action:
          "Either pass project_id, or call `agentry_create_project` to create one (which becomes default).",
      },
    };
  }
  const status = input.status ?? "open";
  const resp = await api.listCases(cfg, picked.id, status);
  const local = picked.project;
  const enriched = resp.cases.map((c) => ({
    ...c,
    local_path: local?.local_path ?? null,
  }));
  return {
    project_id: picked.id,
    status,
    cases: enriched,
    next_action:
      enriched.length === 0
        ? "No cases match. Either trigger one with `agentry_capture_test_event`, or wait for a real one."
        : "For each case, `cd` to its `local_path` and call `agentry_get_case` for the stack + suppression hints.",
  };
}

async function handleGetCase(caseId: string): Promise<ToolResult> {
  if (!caseId) {
    return {
      error: {
        code: "missing_case_id",
        message: "case_id is required",
        next_action: "Pass case_id from the output of `agentry_list_cases`.",
      },
    };
  }
  const cfg = loadConfig();
  const detail = await api.getCase(cfg, caseId);
  // Enrich with local_path looked up by project_id.
  const localProject = projectByLookup(cfg, detail.project_id);
  const localPath = localProject?.local_path ?? detail.local_path ?? null;
  return {
    ...detail,
    local_path: localPath,
    next_action:
      detail.next_actions && detail.next_actions.length > 0
        ? detail.next_actions.join(" / ")
        : `Investigate at ${localPath ?? "(local_path unknown — store it via agentry_create_project)"}.`,
  };
}

async function handleResolveCase(input: {
  case_id: string;
  summary?: string;
  pr_url?: string;
}): Promise<ToolResult> {
  if (!input.case_id) {
    return {
      error: { code: "missing_case_id", message: "case_id is required" },
    };
  }
  const cfg = loadConfig();
  const updated = await api.updateCase(cfg, input.case_id, {
    status: "resolved",
    agent_summary: input.summary,
    pr_url: input.pr_url,
  });
  return {
    ok: true,
    case: updated,
    next_action:
      "Case resolved. If this fingerprint is likely to recur and you want auto-suppression, " +
      "call `agentry_record_suppression` with action 'auto_resolve' or 'auto_ignore'.",
  };
}

async function handleMarkSpurious(input: {
  case_id: string;
  reason?: string;
  suppress_pattern?: string;
}): Promise<ToolResult> {
  if (!input.case_id) {
    return { error: { code: "missing_case_id", message: "case_id is required" } };
  }
  const cfg = loadConfig();
  const updated = await api.updateCase(cfg, input.case_id, {
    status: "spurious",
    agent_summary: input.reason,
  });
  let suppression_id: string | null = null;
  if (input.suppress_pattern) {
    try {
      const r = await api.recordSuppression(cfg, updated.project_id, {
        fingerprint_pattern: input.suppress_pattern,
        action: "auto_ignore",
        reason: input.reason,
      });
      suppression_id = r.id;
    } catch (err) {
      // Surface the suppression failure but don't undo the spurious mark.
      return {
        ok: true,
        case: updated,
        suppression_error: summarizeApiError(err).error,
        next_action:
          "Case marked spurious, but suppression rule failed to save. " +
          "Retry `agentry_record_suppression` independently.",
      };
    }
  }
  return {
    ok: true,
    case: updated,
    suppression_id,
    next_action: suppression_id
      ? "Case is spurious and a noise rule is in place. Future matching events will be auto-ignored."
      : "Case is spurious. To prevent future noise, call `agentry_record_suppression`.",
  };
}

async function handleRecordSuppression(input: {
  project_id?: string;
  fingerprint_pattern: string;
  action: "auto_ignore" | "auto_resolve" | "prompt_hint";
  reason?: string;
  hint_text?: string;
}): Promise<ToolResult> {
  if (!input.fingerprint_pattern) {
    return { error: { code: "missing_pattern", message: "fingerprint_pattern is required" } };
  }
  if (!input.action) {
    return { error: { code: "missing_action", message: "action is required" } };
  }
  if (input.action === "prompt_hint" && !input.hint_text) {
    return {
      error: {
        code: "missing_hint_text",
        message: "hint_text is required when action is 'prompt_hint'",
        next_action: "Provide hint_text — it's the message attached to future matching cases.",
      },
    };
  }
  const cfg = loadConfig();
  const picked = pickProject(cfg, input.project_id);
  if (!picked) {
    return {
      error: {
        code: "no_project",
        message: "No project_id given and no default project set.",
        next_action: "Pass project_id or call `agentry_create_project` first.",
      },
    };
  }
  const resp = await api.recordSuppression(cfg, picked.id, {
    fingerprint_pattern: input.fingerprint_pattern,
    action: input.action,
    reason: input.reason,
    hint_text: input.hint_text,
  });
  return {
    ok: true,
    suppression_id: resp.id,
    project_id: picked.id,
    next_action: "Future matching events will follow the suppression rule.",
  };
}

async function handleCaptureTestEvent(projectId?: string): Promise<ToolResult> {
  const cfg = loadConfig();
  const picked = pickProject(cfg, projectId);
  if (!picked || !picked.project) {
    return {
      error: {
        code: "no_project",
        message:
          "No project found locally. The DSN is stored locally only for projects created via this MCP — " +
          "if the project was created elsewhere, call `agentry_list_projects` and `agentry_install_sdk` first, " +
          "or recreate the project here.",
        next_action: "Call `agentry_create_project` with a name to mint a fresh DSN.",
      },
    };
  }
  const dsn = picked.project.dsn;
  const parsed = parseDsn(dsn);
  if (!parsed) {
    return {
      error: {
        code: "bad_dsn",
        message: `Stored DSN for project ${picked.id} is not parseable.`,
        next_action: "Recreate the project via `agentry_create_project`.",
      },
    };
  }
  const event = buildSyntheticEvent();
  // Pass the full DSN as auth — the API accepts either the token alone or the full DSN form.
  const resp = await api.storeEvent(cfg, parsed.projectId, dsn, event);
  return {
    ok: true,
    project_id: picked.id,
    event_id: resp.id,
    case_id: resp.case_id ?? null,
    next_action: resp.case_id
      ? `Event ingested. Call \`agentry_get_case\` with case_id="${resp.case_id}" to see how it looks to the agent flow.`
      : "Event ingested. The case may take a moment to materialize — call `agentry_list_cases` shortly.",
  };
}
