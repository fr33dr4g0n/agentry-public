// MCP tool definitions + dispatch.
// Each tool's response is shaped to give the calling agent enough context to
// choose its next action without re-asking the user.

import type { AgentryConfig, AgentryProjectConfig } from "@agentrysh/shared";
import { parseDsn } from "@agentrysh/shared";
import { api, type ApiError } from "./api.js";
import { loadConfig, saveConfig } from "./config.js";
import { getOnboardingHint } from "./onboarding.js";
import {
  getMemoryPath,
  readCaseSection,
  upsertCaseSection,
  MEMORY_FILENAME,
} from "./memory.js";
import * as fs from "node:fs";

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
    name: "agentry_login",
    description:
      "Authenticate the user via GitHub device flow. Returns an API key, stored locally. " +
      "" +
      "RECOMMENDED two-call sequence for interactive sessions: " +
      "  1. Call with mode='start_only' → returns user_code + verification_uri + device_code. " +
      "     Show the user the code and URL (DO NOT ask them to confirm authorization — they'll " +
      "     just open the URL, paste the code, and you'll poll). " +
      "  2. IMMEDIATELY call again with mode='full' + the device_code from step 1. " +
      "     This blocks and auto-polls every ~5s for up to timeout_seconds (default 300 = 5min). " +
      "     Returns the api_key when the user authorizes, or status='expired'/'denied' on failure. " +
      "" +
      "DO NOT ask the user 'tell me once you've authorized'. The second call handles the wait. " +
      "" +
      "Single-call shortcut: call with mode='full' and no device_code — the tool starts the flow " +
      "AND polls in one shot, but the user can't see the code until the call returns. Only use " +
      "this when there's no interactive user (e.g. you've already shown the code another way).",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["full", "start_only", "poll_once"],
          description:
            "'full' (default) — blocks and polls until authorized, expired, denied, or timeout. " +
            "If device_code is also provided, skips the start step and just polls the existing flow. " +
            "'start_only' — returns verification_uri + user_code + device_code immediately, no polling. " +
            "'poll_once' — single non-blocking poll of an existing device_code (rare; prefer mode='full' " +
            "+ device_code to let the tool handle the wait).",
        },
        device_code: {
          type: "string",
          description:
            "Existing device_code from a prior mode='start_only' call. Pass with mode='full' to " +
            "block-and-poll on an existing flow (the user has already seen the code). Required " +
            "for mode='poll_once'.",
        },
        timeout_seconds: {
          type: "number",
          description: "Cap on total polling time when mode='full'. Defaults to 300 (5 min).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_publish_query",
    description:
      "Mint a public-fetchable URL for a specific recipe + params combination. The returned " +
      "URL can be embedded in a PUBLIC dashboard (your marketing site, a customer-facing " +
      "metrics page, etc.) — visitors fetch the rendered query results without an account, " +
      "credential, or session." +
      "" +
      "Auth model: the URL embeds the user's `agp_…` PUBLIC key (auto-minted at login alongside " +
      "the private `agk_…`). agp_ is read-only AND can only fetch publications you explicitly " +
      "created. Even if the URL leaks to the entire internet, the worst case is that the SAME " +
      "(recipe + params) query you already chose to make public can be re-fetched. No other " +
      "data is reachable." +
      "" +
      "Workflow: ASK the user what to publish (which metric, which params), call this tool, " +
      "embed the returned `public_url?key=<agp_…>` in their page. CORS is open. Revoke with " +
      "agentry_revoke_publication.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        recipe_id: {
          type: "string",
          description:
            "ID from agentry_list_recipes. Bound to this publication permanently — to change " +
            "the recipe, revoke + republish.",
        },
        params: {
          type: "object",
          description:
            "Recipe params (matches recipe.params schema). Bound to this publication.",
        },
        description: {
          type: "string",
          description:
            "What this dashboard widget shows — for your own future reference in " +
            "agentry_list_publications.",
        },
      },
      required: ["recipe_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_list_publications",
    description:
      "List active public-fetchable query publications for this project. Returns each one's " +
      "public_url + last_used_at. Use this to audit what's currently exposed publicly.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_revoke_publication",
    description:
      "Revoke a public-fetchable query publication. The public_url will start returning 410 " +
      "(Gone). Use when the dashboard widget is decommissioned or the embedded URL leaks " +
      "somewhere unintended.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        publication_id: { type: "string" },
      },
      required: ["publication_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_configure_session_replay",
    description:
      "Enable / disable / customize PostHog session replay for the user's project. " +
      "Session replay is OFF by default — agentry users opt in. Recordings eat significant " +
      "storage, so pick a strategy that matches the customer's debugging needs:" +
      "" +
      "  - 'off'          — disable. No new sessions recorded." +
      "  - 'all'          — 100% sampling. Heavy storage cost; only pick if the customer's " +
      "                     traffic is low AND they want every session recorded." +
      "  - 'sampled'      — random sample at sample_rate (0–1, default 0.1 = 10%). Good " +
      "                     balance of coverage + cost for most apps." +
      "  - 'url_scoped'   — record only sessions that hit specific URLs (e.g. /checkout/*). " +
      "                     Pass url_triggers: [{url, matching}]. Best for funnel debugging." +
      "  - 'errors_only'  — record nothing by default, but the customer's app calls " +
      "                     `posthog.startSessionRecording()` from captureError (or wherever " +
      "                     they want). Cheapest; recording starts JUST IN TIME when something " +
      "                     breaks. After picking this, ALSO wire the call into the customer's " +
      "                     agentry helper (drop_in_helper from agentry_install_guide)." +
      "" +
      "Workflow: ASK THE USER first which strategy they want and what retention. Then call this " +
      "tool with the answer. If 'errors_only', also edit the agentry helper to call " +
      "posthog.startSessionRecording() inside captureError. After this, recordings show up in " +
      "PostHog's Replay tab — call agentry_session_replay_status to get the deep-link URL.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id. Defaults to local default." },
        strategy: {
          type: "string",
          enum: ["off", "all", "sampled", "url_scoped", "errors_only"],
        },
        sample_rate: {
          type: "number",
          description: "0–1; only used when strategy='sampled'. Default 0.1 (10%).",
        },
        retention_days: {
          type: "number",
          description: "How many days to retain recordings. Storage-bounded. 30 / 90 / 365.",
        },
        min_duration_ms: {
          type: "number",
          description:
            "Drop recordings shorter than this (ms). 0 = keep all. Useful for skipping bounces. " +
            "Default unset.",
        },
        url_triggers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              matching: { type: "string", enum: ["exact", "regex"] },
            },
            required: ["url"],
            additionalProperties: false,
          },
          description: "When strategy='url_scoped': pages where recording should start.",
        },
      },
      required: ["strategy"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_session_replay_status",
    description:
      "Get the current session-replay configuration for the user's project AND a deep-link " +
      "URL into PostHog's Replay tab. For programmatic recording retrieval (returning the " +
      "list of recordings or player URLs), call agentry_list_session_replays / " +
      "agentry_get_session_replay — both work as of 2026-05-15 (master Personal API Key " +
      "now has session_recording:read scope).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  // ---------------------------------------------------------------------------
  // PostHog per-user-team CRUD: feature flags, cohorts, surveys, session
  // recordings retrieval. Each wraps an /api/projects/<team_id>/<resource>/
  // endpoint on the user's per-user PostHog team. Master Personal API Key
  // has `*` scope as of 2026-05-15 so all of these are live.
  // ---------------------------------------------------------------------------
  {
    name: "agentry_list_feature_flags",
    description:
      "List feature flags on the user's PostHog project. Use this to inspect what flags " +
      "exist before creating new ones, or to find a flag's id to update/delete it. Each " +
      "flag has: id, key, name, active, filters (rollout rules), created_at.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        limit: { type: "number", description: "Max flags to return (default 100, max 200)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_get_feature_flag",
    description:
      "Fetch a single feature flag's full configuration (filters, variants, conditions).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        flag_id: {
          type: "string",
          description: "Numeric id from agentry_list_feature_flags (NOT the flag's key string).",
        },
      },
      required: ["flag_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_create_feature_flag",
    description:
      "Create a new feature flag. Two shapes supported:" +
      "" +
      "  - Simple: pass {key, name?, active?, rollout_percentage?} — single-group filter at " +
      "    the given % rollout (0-100). Default: active=true, rollout=100." +
      "" +
      "  - Advanced: pass {key, name?, active?, filters} — `filters` is PostHog's raw filter " +
      "    object ({groups: [{properties: [...], rollout_percentage}], multivariate?, …}). " +
      "    Use this for property-targeted rules, multi-variant flags, or cohort-scoped flags.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        key: { type: "string", description: "Stable slug used in code (e.g. `new-checkout-flow`)." },
        name: { type: "string", description: "Human label (defaults to key)." },
        active: { type: "boolean", description: "Default true." },
        rollout_percentage: { type: "number", description: "0–100 (simple shape)." },
        filters: { type: "object", description: "Raw PostHog filter object (advanced shape)." },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_update_feature_flag",
    description:
      "Patch a feature flag. Toggle on/off via {active}, change rollout via {rollout_percentage}, " +
      "rename via {name}, or replace targeting with {filters}.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        flag_id: { type: "string" },
        active: { type: "boolean" },
        name: { type: "string" },
        rollout_percentage: { type: "number" },
        filters: { type: "object" },
      },
      required: ["flag_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_delete_feature_flag",
    description:
      "Soft-delete a feature flag (sets deleted=true; recoverable in PostHog's web UI).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        flag_id: { type: "string" },
      },
      required: ["flag_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_list_cohorts",
    description:
      "List cohorts (dynamic user segments) on the user's PostHog project. Cohorts are " +
      "groups of users matching a filter (e.g. 'users who did event X in last 30 days'). " +
      "Used by feature-flag targeting and HogQL queries.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_get_cohort",
    description: "Fetch a single cohort's definition (filters, last calculation time, count).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        cohort_id: { type: "string" },
      },
      required: ["cohort_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_create_cohort",
    description:
      "Create a cohort. Two shapes supported:" +
      "" +
      "  - Simple: {name, event, days?} — users who fired `event` at least once in the last " +
      "    N days (days defaults to 30)." +
      "" +
      "  - Advanced: {name, groups} — `groups` is PostHog's raw cohort-group filter array, " +
      "    for property-targeted or multi-condition cohorts.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        name: { type: "string" },
        event: { type: "string", description: "Event name (simple shape)." },
        days: { type: "number", description: "Lookback window in days (default 30, simple shape)." },
        groups: { type: "array", description: "Raw PostHog cohort-group filters (advanced shape)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_delete_cohort",
    description: "Soft-delete a cohort (recoverable in PostHog's web UI).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        cohort_id: { type: "string" },
      },
      required: ["cohort_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_list_surveys",
    description:
      "List surveys on the user's PostHog project. A survey is a popup/banner/widget the " +
      "customer's PostHog-JS-enabled site renders to ask users a question (NPS, CSAT, " +
      "free-text). Responses land as `survey sent` events.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_get_survey",
    description:
      "Fetch a single survey's definition. To read responses, query HogQL: " +
      "`SELECT properties FROM events WHERE event = 'survey sent' AND properties.\\$survey_id = '<id>'`.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        survey_id: { type: "string" },
      },
      required: ["survey_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_create_survey",
    description:
      "Create a survey. Quick shape: {name, question, question_type?} for a single-question " +
      "popover (question_type defaults to 'open' — also 'rating', 'single_choice', " +
      "'multiple_choice', 'link'). Advanced: pass {name, questions: [...]} for multi-question. " +
      "" +
      "Surveys are created in DRAFT — pass start_date (ISO) to launch immediately, or call " +
      "PATCH /surveys/:id with {start_date} later.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        name: { type: "string" },
        type: {
          type: "string",
          enum: ["popover", "widget", "button", "api"],
          description: "Render style. Default 'popover'.",
        },
        question: { type: "string", description: "Single-question quick shape." },
        question_type: {
          type: "string",
          enum: ["open", "rating", "single_choice", "multiple_choice", "link"],
        },
        questions: { type: "array", description: "Multi-question array (advanced shape)." },
        description: { type: "string" },
        linked_flag_id: { type: "number" },
        targeting_flag_id: { type: "number" },
        conditions: { type: "object" },
        appearance: { type: "object" },
        start_date: { type: "string", description: "ISO timestamp to launch immediately." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_delete_survey",
    description: "Delete a survey (PostHog hard-deletes survey rows on DELETE).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        survey_id: { type: "string" },
      },
      required: ["survey_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_list_session_replays",
    description:
      "List session recordings on the user's PostHog project. Use this to find replays " +
      "linked to a user (distinct_id) or a time range — e.g. when investigating an error, " +
      "filter by the affected user's distinct_id to find the recording leading up to it. " +
      "" +
      "Note: session replay must be ENABLED first (call agentry_configure_session_replay). " +
      "Recordings are only captured while a strategy is on.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        distinct_id: {
          type: "string",
          description: "Filter to one user (e.g. from a case's affected_users).",
        },
        date_from: { type: "string", description: "ISO timestamp lower bound." },
        date_to: { type: "string", description: "ISO timestamp upper bound." },
        limit: { type: "number", description: "Max recordings (default 25, max 100)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_get_session_replay",
    description:
      "Fetch a single session recording's metadata + player URL. Open `player_url` in a " +
      "browser to watch. For programmatic DOM-event inspection (the snapshot data), call " +
      "the snapshots subresource directly via curl using the agentry-injected master key.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        replay_id: { type: "string" },
      },
      required: ["replay_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_repair_analytics",
    description:
      "Re-attempt PostHog provisioning for the authenticated user. Idempotent — if the user " +
      "already has a PostHog project, returns its id without recreating. Use this when " +
      "agentry_verify_install reports analytics ❌ with reason 'no_posthog_project' OR when a " +
      "/v1/track/ call returns 503 with that code. " +
      "" +
      "DO NOT re-run agentry_login for this failure mode — that mints a new api_key and " +
      "churns the user's local config. This tool runs only the provisioning step that was " +
      "supposed to happen at login.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
      "Pass `local_path` (the absolute path to the repo on disk) so future cases route back to the right directory. " +
      "AFTER creating the project, your job is to install ALL THREE signal types — errors, analytics, deploys — " +
      "in one continuous pass by walking agentry_install_guide. Do not stop after errors and ask the user " +
      "permission to wire analytics or deploys. They are part of the install, not optional follow-ups. " +
      "If a payment processor is detected, revenue events are mandatory.",
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
      "Get install instructions for the target runtime. Returns ready-to-paste code + env vars. " +
      "Works for every HTTP-capable runtime: Node/TypeScript gets the typed SDK; Python, Ruby, Go, PHP, etc. " +
      "get DSN-based HTTP instructions that hit the same ingest endpoint. By design — the ingest protocol is " +
      "plain HTTP so there's no runtime that's 'unsupported'. Call this with whatever language you detected; " +
      "do NOT warn the user that their stack is unsupported. For framework-specific checklists " +
      "(Next.js, FastAPI, Django, Rails, …) prefer `agentry_install_guide`.",
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description:
            "Runtime / language detected from the repo. Examples: 'node', 'python', 'ruby', 'go', 'php', 'rust'. " +
            "Defaults to 'node'. Any value is accepted — non-Node languages get DSN/HTTP instructions.",
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
      "Surface `next_actions` to the agent. If the returned stack frames look minified (file paths " +
      "like `chunks/abc.js`, function names like `t.a`), call agentry_unmangle_stack next.",
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
    name: "agentry_unmangle_stack",
    description:
      "Translate a minified stack trace using sourcemaps stored in agentry. " +
      "agentry stores the .map files; THIS tool does the translation LOCALLY in the MCP process " +
      "using @jridgewell/trace-mapping. The code that runs is in the @agentrysh/mcp npm package — " +
      "readable on npm, version-pinned, no server-side magic. " +
      "Returns translated frames + the .map source_urls fetched + the exact code snippet that " +
      "produced the translation, so the result is fully auditable. " +
      "Call this whenever agentry_get_case returns a stack with minified frames (file paths like " +
      "`chunks/abc.js`, function names like `t.a` / `n.exports`). For server-side stacks (paths " +
      "in `src/...` or `node_modules/...`) you don't need this — the frames are already readable.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string", description: "Case id whose stack(s) to unmangle." },
        event_id: {
          type: "string",
          description:
            "Optional: a specific recent_events[].id from the case detail. If omitted, " +
            "unmangles every event's stack in the case.",
        },
        release_id: {
          type: "string",
          description:
            "Optional override of the deploy SHA used to look up sourcemaps. Defaults to each " +
            "event's deploy_sha. Use this if you uploaded sourcemaps under a different release id.",
        },
      },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_upload_sourcemap",
    description:
      "Upload a single .map file to agentry's storage. Use this for ad-hoc uploads from the agent " +
      "(e.g. uploading the latest local build's maps before investigating). For production deploys, " +
      "prefer the curl loop in the install guide's upload_sourcemaps_for_minified_stacks step so " +
      "the upload runs in CI on every deploy. " +
      "Wraps POST /v1/sourcemaps/{project_id}/. Same Bearer-DSN auth (uses the DSN cached locally " +
      "by agentry_create_project).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project id. If omitted, uses the local default project.",
        },
        map_file_path: {
          type: "string",
          description:
            "Absolute path to the .map file on disk. The MCP reads it and POSTs the contents.",
        },
        source_url: {
          type: "string",
          description:
            "Pathname the minified .js is served at (e.g. /_next/static/chunks/abc.js). MUST " +
            "match what the browser reports in stack-frame `filename` for lookup to work.",
        },
        release_id: {
          type: "string",
          description:
            "Deploy SHA (or any release identifier). Defaults to `default`. Match this to the " +
            "deploy_sha on the events whose stacks you want to translate.",
        },
      },
      required: ["map_file_path", "source_url"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_list_sourcemaps",
    description:
      "List sourcemaps uploaded for a project, optionally filtered by release_id. Wraps " +
      "GET /v1/sourcemaps/{project_id}/. Useful for verifying an upload ran, or for finding which " +
      "deploys have maps stored.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project id. If omitted, uses the local default project.",
        },
        release_id: {
          type: "string",
          description: "Filter to a specific release/deploy SHA. Optional.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_delete_sourcemaps",
    description:
      "Delete every sourcemap uploaded under a specific release_id. Use this to clean up after an " +
      "old deploy's maps are no longer needed (cases pinned to that deploy_sha will lose " +
      "translation capability — that's intentional, run it only when you're sure). Wraps DELETE " +
      "/v1/sourcemaps/{project_id}/?release_id=…. Refuses to operate without an explicit release_id " +
      "(no bulk wipes by accident).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project id. If omitted, uses the local default project.",
        },
        release_id: {
          type: "string",
          description: "The release/deploy SHA whose maps to delete. Required — no default.",
        },
      },
      required: ["release_id"],
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
            "Optional substring pattern to match the fingerprint, auto-ignoring future matches",
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
          description: "Substring match against the case fingerprint",
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
  {
    name: "agentry_record_deploy",
    description:
      "Record a deploy event. Useful when CI doesn't call the SDK directly. Cases ingested after this " +
      "will surface the deploy in their `recent_deploys` so the agent can attribute regressions.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        sha: { type: "string", description: "Git SHA of the deployed commit" },
        branch: { type: "string" },
        environment: { type: "string", description: "e.g. 'production', 'staging'" },
        message: { type: "string", description: "Commit / deploy message" },
        url: { type: "string", description: "Deploy or commit URL" },
        actor: { type: "string", description: "Person or service that triggered the deploy" },
      },
      required: ["sha"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_list_deploys",
    description:
      "List recent deploys for a project. Useful for cross-referencing case timestamps with deploy timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        limit: { type: "number", description: "Defaults to 20" },
        since: { type: "number", description: "Unix seconds — only return deploys after this" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_track_test_event",
    description:
      "Fire a synthetic analytics event through the agentry track endpoint to verify the PostHog forwarding " +
      "is wired up. Returns whether the forwarding succeeded.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        event: {
          type: "string",
          description: "Event name. Defaults to 'agentry_verify'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_analytics_query",
    description:
      "Run a HogQL query against the user's PostHog project. The agent uses this to investigate funnels, " +
      "retention, paths, anomalies — anything PostHog can express in HogQL. " +
      "Examples: SELECT count() FROM events WHERE event = 'signup_completed' AND timestamp > now() - INTERVAL 7 DAY",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        query: { type: "string", description: "HogQL query string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_install_guide",
    description:
      "Get the comprehensive, framework-aware install checklist. Returns ordered steps with file hints, " +
      "code snippets, and validation criteria. Covers Node, Next.js, Express, Python (FastAPI, Flask, Django), " +
      "Ruby/Rails, Go, and a generic HTTP fallback for anything else. " +
      "CRITICAL: 'install agentry' means installing ALL THREE signal types — errors, analytics, deploys — " +
      "in one pass. Do not stop after wiring errors and ask the user permission to wire analytics or deploys. " +
      "They're part of the install, not follow-ups. The guide makes this explicit; walk every step before " +
      "declaring done. If a payment processor (Stripe/Paddle/etc.) is detected in the repo, revenue events " +
      "are MANDATORY — not optional. Read the guide BEFORE editing any customer code.",
    inputSchema: {
      type: "object",
      properties: {
        framework: {
          type: "string",
          description:
            "Framework detected from the repo. Common values: 'node', 'next', 'express', 'python', 'fastapi', " +
            "'flask', 'django', 'ruby', 'rails', 'go', 'generic'. Any value is accepted; unknown frameworks " +
            "fall back to generic HTTP/DSN instructions.",
        },
        signal_types: {
          type: "array",
          items: { type: "string", enum: ["errors", "analytics", "deploys"] },
          description:
            "Subset of signals to include. Defaults to all three — keep it that way. Passing a subset is for " +
            "edge cases (re-running the guide for a single signal type the user previously skipped). " +
            "First-time installs ALWAYS include all three.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_verify_install",
    description:
      "Comprehensive sanity check: fires a synthetic error, a synthetic analytics event, and a synthetic " +
      "deploy event, then reports which signal types reached agentry. Run this AFTER walking through " +
      "agentry_install_guide. " +
      "MUST be run with NO skipped signal types on a first-time install — the install is not done until " +
      "all three return OK. If any signal returns FAIL, the corresponding wire_* step was skipped or " +
      "wired incorrectly; the agent must go back and fix it before declaring the install complete. Do not " +
      "report 'installed' to the user with one or two ✅s and a ❌; that's a half-install.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        skip: {
          type: "array",
          items: { type: "string", enum: ["errors", "analytics", "deploys"] },
          description:
            "ONLY for re-runs after a partial install has already been verified. On a first install, " +
            "leave this empty — all three signal types must verify before the install counts as done.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_list_recipes",
    description:
      "List the canonical query recipes that answer common questions ('how many DAU?', " +
      "'show me the funnel drop-off', 'errors after the last deploy?'). Each recipe has a " +
      "HogQL/SQL template, parameters with defaults, expected columns, and a render_hint. " +
      "Use this BEFORE composing ad-hoc HogQL — agentry has no dashboard, so the agent IS the dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["users", "retention", "funnels", "events", "errors", "deploys"],
          description: "Optional category filter.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_run_recipe",
    description:
      "Run a recipe by id. Returns rows + a render_hint the agent uses to format the answer " +
      "(markdown table / ASCII bar chart / funnel breakdown / scalar). " +
      "If no recipe fits the user's question, fall back to `agentry_analytics_query` with hand-rolled HogQL.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: { type: "string", description: "Recipe id from agentry_list_recipes." },
        project_id: { type: "string", description: "Defaults to the local default project." },
        params: {
          type: "object",
          description: "Parameter values keyed by name. Defaults are applied for any omitted.",
          additionalProperties: true,
        },
      },
      required: ["recipe_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_query_docs",
    description:
      "Return markdown documentation of the queryable schema (analytics events table, errors, " +
      "deploys) plus a HogQL primer plus visualization hints. Read this when the user's question " +
      "doesn't match any recipe and the agent needs to compose ad-hoc HogQL.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agentry_project_health",
    description:
      "Heartbeat / state-of-project view. Returns last_event_received_at, last_deploy_at, " +
      "events_last_hour, open_cases count, usage_this_month with caps and percentages, and per-webhook " +
      "last_status. Use this when the user asks 'is everything working?' or to detect ingest gaps " +
      "('we shipped 2h ago and no events have come in — something broke').",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_create_alert",
    description:
      "Store an alert definition: a recipe + parameters + threshold + which webhook to fire. " +
      "agentry doesn't run the schedule for you — your cron / GitHub Actions / Cloudflare Cron " +
      "calls POST /alerts/:id/evaluate when you want the check run. On threshold cross, agentry " +
      "fires the linked webhook so your endpoint reacts.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        recipe_id: { type: "string", description: "Analytics-backend recipes only for v0." },
        threshold_column: { type: "string" },
        threshold_op: { type: "string", enum: ["gt", "gte", "lt", "lte", "eq"] },
        threshold_value: { type: "number" },
        params: { type: "object", additionalProperties: true },
        description: { type: "string" },
        webhook_id: { type: "string" },
        project_id: { type: "string" },
      },
      required: ["name", "recipe_id", "threshold_column", "threshold_op", "threshold_value"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_list_alerts",
    description: "List configured alerts with last_evaluated_at / last_triggered_at / last_value.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_evaluate_alert",
    description:
      "Run an alert's recipe NOW, compare against the threshold, fire the linked webhook if crossed. " +
      "Returns {triggered, fired, current_value}. Call this from your scheduler.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string" },
        project_id: { type: "string" },
      },
      required: ["alert_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_delete_alert",
    description: "Remove an alert definition.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string" },
        project_id: { type: "string" },
      },
      required: ["alert_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_remember",
    description:
      "Append/update a markdown section about a case in the local agentry_memory.md file at the project's local_path. " +
      "Use this when you've learned something investigating a case (root cause, suspect deploy, the fix you applied, " +
      "what to watch out for). Future investigations of similar cases will see these notes via the agent's file-reading " +
      "tools — this is the agent's persistent memory. Safe to commit. " +
      "If the case_id section already exists, it's overwritten.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        summary: {
          type: "string",
          description:
            "Markdown body — what was learned. Be specific: 'introduced by deploy abc123 which removed null guard from user.email; fixed in PR #91 by restoring guard + adding test'.",
        },
        fingerprint: { type: "string" },
        status: { type: "string", description: "open / investigating / resolved / spurious" },
        error_type: { type: "string" },
        pr_url: { type: "string" },
        watch_for: {
          type: "string",
          description: "Heuristic for spotting similar bugs in the future ('check notification_service.ts:142 for the same pattern').",
        },
        tags: { type: "array", items: { type: "string" } },
        project_id: {
          type: "string",
          description: "Defaults to the local default project (the file lives in that project's local_path).",
        },
      },
      required: ["case_id", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_recall",
    description:
      "Read the current contents of `<local_path>/agentry_memory.md`. " +
      "Useful when investigating a new case to see if a similar one was handled before. " +
      "You can also use the standard file-reading tools directly — this is just a convenience.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string", description: "If set, returns just this case's section." },
        project_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_register_webhook",
    description:
      "Register a webhook URL to receive signed POSTs when interesting events happen. " +
      "Event names are FREE-FORM strings — subscribe to anything the substrate emits: " +
      "(a) server events: case.created, case.resolved, case.investigating, case.spurious, " +
      "case.ignored, case.reopened, deploy.recorded, alert.triggered, alert.recovered. " +
      "(b) any analytics event name your customer's app emits (signup_completed, purchase, " +
      "checkout_started, video_uploaded, ...). " +
      "(c) wildcards: \"*\" (everything), \"case.*\" (all case transitions), \"alert.*\" (all alerts). " +
      "Call agentry_list_event_names first to discover what's actually flowing. You can also " +
      "subscribe BEFORE an event exists — the hook will fire as soon as the app emits it. " +
      "Returns signing_secret ONCE — store it. Endpoint verifies X-Agentry-Signature: t=<unix>,v1=<hex> " +
      "via HMAC-SHA256(rawBody, signing_secret).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https:// URL to receive deliveries" },
        events: {
          type: "array",
          items: { type: "string" },
          description:
            "Required. Non-empty array of event names. Any string is valid; wildcards \"*\" and " +
            "\"<namespace>.*\" supported. Use agentry_list_event_names to discover names.",
        },
        description: { type: "string", description: "What this hook is for (human-readable note)." },
        project_id: { type: "string", description: "Defaults to local default project." },
      },
      required: ["url", "events"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_list_event_names",
    description:
      "Discover which event names you can subscribe a webhook to. Returns: " +
      "(a) server_emitted — canonical names emitted by agentry itself (case.*, deploy.recorded, alert.*); " +
      "(b) analytics_events — distinct analytics event names seen in the last 30 days, with count + last_seen; " +
      "(c) wildcards — supported wildcard patterns. " +
      "Call this BEFORE agentry_register_webhook so you don't subscribe to a name that doesn't exist. " +
      "If you want a hook on an event that's not yet flowing, subscribe to its expected name — the hook " +
      "will fire as soon as the customer's app emits it.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Defaults to local default project." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_list_webhooks",
    description:
      "List webhooks registered on a project, including last_status / last_error so the agent " +
      "can tell if the customer's endpoint is healthy.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_test_webhook",
    description:
      "Fire a synthetic test event to a registered webhook. Useful right after registration to " +
      "confirm the signing secret + endpoint are wired up correctly.",
    inputSchema: {
      type: "object",
      properties: {
        webhook_id: { type: "string" },
        project_id: { type: "string" },
      },
      required: ["webhook_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_delete_webhook",
    description: "Remove a webhook subscription. No further deliveries.",
    inputSchema: {
      type: "object",
      properties: {
        webhook_id: { type: "string" },
        project_id: { type: "string" },
      },
      required: ["webhook_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_automation_docs",
    description:
      "Return markdown documentation showing common automation patterns built on agentry's webhooks: " +
      "auto-fix-on-error, deploy regression alerts, weekly digests, etc. Each pattern includes a " +
      "ready-to-deploy Cloudflare Worker / Vercel function template the agent can drop into the customer's repo.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agentry_send_feedback",
    description:
      "File feedback for the agentry team when something doesn't work or is missing. " +
      "Call this in exactly two situations: " +
      "(1) the user explicitly asks for a feature that doesn't exist or expresses frustration that agentry " +
      "isn't doing what they want ('I wish it could…', 'why doesn't it…', 'this doesn't work', " +
      "'feature request: …'); " +
      "(2) you have made 2+ failed attempts at the same task — same MCP tool returning errors, or repeatedly " +
      "failing to find a recipe/route for what the user asked. " +
      "File it ONCE per distinct issue per session — don't spam. Quote the user verbatim in `message` where " +
      "possible. Don't apologize repeatedly to the user; just tell them you've logged it.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["missing_feature", "bug", "ux_friction", "other"],
          description:
            "missing_feature = capability doesn't exist; bug = something behaves wrong; " +
            "ux_friction = works but is awkward/confusing; other = anything else.",
        },
        message: {
          type: "string",
          description:
            "The user's complaint in their own words where possible. If you're filing this after " +
            "2+ failed attempts, write a one-line summary of what they were trying to do.",
        },
        agent_note: {
          type: "string",
          description:
            "Optional: what YOU (the agent) were trying to do, which tools you called, what failed. " +
            "Helps the agentry team reproduce.",
        },
        tool_name: {
          type: "string",
          description: "If a specific MCP tool was involved, name it (e.g. 'agentry_run_recipe').",
        },
        attempt_count: {
          type: "number",
          description: "How many times you tried the same task before giving up. Required for the 2+-failure path.",
        },
        project_id: {
          type: "string",
          description: "Optional project context. Defaults to none.",
        },
        claude_session_id: {
          type: "string",
          description:
            "Optional: a stable identifier for this Claude session, so duplicate feedback from the same " +
            "session can be grouped server-side.",
        },
      },
      required: ["kind", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "agentry_list_feedback",
    description:
      "List feedback YOU (this user) have filed. Operator view — use it to review what's been logged " +
      "and decide what to address. Returns most recent first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Defaults to 50, max 500." },
        kind: {
          type: "string",
          enum: ["missing_feature", "bug", "ux_friction", "other"],
        },
        resolved: { type: "boolean", description: "Filter on resolved status." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agentry_suggested_next_steps",
    description:
      "After install/verify, surface this to the user: a curated list of 'what would you like to do " +
      "next?' prompts with paste-ready templates ('Build a customized analytics dashboard', " +
      "'Build an error monitoring dashboard', 'Generate this week's review post', etc.). " +
      "Each suggestion lists the recipes/tools the agent will use, so the response is predictable. " +
      "State-aware: only suggestions whose prerequisites are met (analytics configured, errors present, " +
      "deploys recorded) are returned.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Defaults to the local default project." },
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
  resp: {
    api_key: string;
    user_id: string;
    prefix: string;
    public_api_key?: string;
  }
): AgentryConfig {
  const next: AgentryConfig = {
    ...cfg,
    api_key: resp.api_key,
    // Persist the agp_ public key too (returned by login response). Only
    // overwrite if the new response provides one; rotation/repair paths
    // don't necessarily return public keys.
    ...(resp.public_api_key && !resp.public_api_key.startsWith("(redacted")
      ? { public_api_key: resp.public_api_key }
      : {}),
  };
  saveConfig(next);
  return next;
}

function requireProjectFromConfig(
  cfg: AgentryConfig,
  projectId: string | undefined,
): { id: string; project: AgentryProjectConfig } | { error: ToolResult } {
  const picked = pickProject(cfg, projectId);
  if (!picked || !picked.project) {
    return {
      error: {
        error: {
          code: "no_project",
          message:
            "No project found locally. Either create one with agentry_create_project or pass project_id explicitly " +
            "(noting: this MCP only knows about projects it created locally — DSNs aren't fetched from the API).",
          next_action: "Call agentry_create_project first.",
        },
      },
    };
  }
  return { id: picked.id, project: picked.project };
}

// Build a Sentry-shaped synthetic event suitable for hitting /v1/logs/:id/.
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
      case "agentry_login":
        return await handleLogin({
          mode:
            a.mode === "start_only" || a.mode === "poll_once"
              ? (a.mode as "start_only" | "poll_once")
              : "full",
          device_code: a.device_code ? String(a.device_code) : undefined,
          timeout_seconds:
            typeof a.timeout_seconds === "number" ? a.timeout_seconds : undefined,
        });
      case "agentry_rotate_key":
        return await handleRotateKey();
      case "agentry_repair_analytics":
        return await handleRepairAnalytics();
      case "agentry_publish_query":
        return await handlePublishQuery({
          project_id: a.project_id ? String(a.project_id) : undefined,
          recipe_id: String(a.recipe_id ?? ""),
          params: a.params && typeof a.params === "object"
            ? (a.params as Record<string, unknown>)
            : undefined,
          description: a.description ? String(a.description) : undefined,
        });
      case "agentry_list_publications":
        return await handleListPublications(a.project_id ? String(a.project_id) : undefined);
      case "agentry_revoke_publication":
        return await handleRevokePublication({
          project_id: a.project_id ? String(a.project_id) : undefined,
          publication_id: String(a.publication_id ?? ""),
        });
      case "agentry_configure_session_replay":
        return await handleConfigureSessionReplay({
          project_id: a.project_id ? String(a.project_id) : undefined,
          strategy: String(a.strategy ?? "") as never,
          sample_rate: typeof a.sample_rate === "number" ? a.sample_rate : undefined,
          retention_days: typeof a.retention_days === "number" ? a.retention_days : undefined,
          min_duration_ms: typeof a.min_duration_ms === "number" ? a.min_duration_ms : undefined,
          url_triggers: Array.isArray(a.url_triggers)
            ? (a.url_triggers as Array<{ url: string; matching?: string }>)
            : undefined,
        });
      case "agentry_session_replay_status":
        return await handleSessionReplayStatus(
          a.project_id ? String(a.project_id) : undefined,
        );
      case "agentry_list_feature_flags":
        return await handleListFeatureFlags({
          project_id: a.project_id ? String(a.project_id) : undefined,
          limit: typeof a.limit === "number" ? a.limit : undefined,
        });
      case "agentry_get_feature_flag":
        return await handleGetFeatureFlag({
          project_id: a.project_id ? String(a.project_id) : undefined,
          flag_id: String(a.flag_id ?? ""),
        });
      case "agentry_create_feature_flag":
        return await handleCreateFeatureFlag({
          project_id: a.project_id ? String(a.project_id) : undefined,
          key: String(a.key ?? ""),
          name: a.name ? String(a.name) : undefined,
          active: typeof a.active === "boolean" ? a.active : undefined,
          rollout_percentage: typeof a.rollout_percentage === "number" ? a.rollout_percentage : undefined,
          filters: a.filters && typeof a.filters === "object" ? (a.filters as Record<string, unknown>) : undefined,
        });
      case "agentry_update_feature_flag":
        return await handleUpdateFeatureFlag({
          project_id: a.project_id ? String(a.project_id) : undefined,
          flag_id: String(a.flag_id ?? ""),
          active: typeof a.active === "boolean" ? a.active : undefined,
          name: a.name ? String(a.name) : undefined,
          rollout_percentage: typeof a.rollout_percentage === "number" ? a.rollout_percentage : undefined,
          filters: a.filters && typeof a.filters === "object" ? (a.filters as Record<string, unknown>) : undefined,
        });
      case "agentry_delete_feature_flag":
        return await handleDeleteFeatureFlag({
          project_id: a.project_id ? String(a.project_id) : undefined,
          flag_id: String(a.flag_id ?? ""),
        });
      case "agentry_list_cohorts":
        return await handleListCohorts(a.project_id ? String(a.project_id) : undefined);
      case "agentry_get_cohort":
        return await handleGetCohort({
          project_id: a.project_id ? String(a.project_id) : undefined,
          cohort_id: String(a.cohort_id ?? ""),
        });
      case "agentry_create_cohort":
        return await handleCreateCohort({
          project_id: a.project_id ? String(a.project_id) : undefined,
          name: String(a.name ?? ""),
          event: a.event ? String(a.event) : undefined,
          days: typeof a.days === "number" ? a.days : undefined,
          groups: Array.isArray(a.groups) ? (a.groups as Array<Record<string, unknown>>) : undefined,
        });
      case "agentry_delete_cohort":
        return await handleDeleteCohort({
          project_id: a.project_id ? String(a.project_id) : undefined,
          cohort_id: String(a.cohort_id ?? ""),
        });
      case "agentry_list_surveys":
        return await handleListSurveys(a.project_id ? String(a.project_id) : undefined);
      case "agentry_get_survey":
        return await handleGetSurvey({
          project_id: a.project_id ? String(a.project_id) : undefined,
          survey_id: String(a.survey_id ?? ""),
        });
      case "agentry_create_survey":
        return await handleCreateSurvey({
          project_id: a.project_id ? String(a.project_id) : undefined,
          name: String(a.name ?? ""),
          type: a.type ? (String(a.type) as "popover" | "widget" | "button" | "api") : undefined,
          question: a.question ? String(a.question) : undefined,
          question_type: a.question_type
            ? (String(a.question_type) as "open" | "rating" | "single_choice" | "multiple_choice" | "link")
            : undefined,
          questions: Array.isArray(a.questions) ? (a.questions as Array<Record<string, unknown>>) : undefined,
          description: a.description ? String(a.description) : undefined,
          linked_flag_id: typeof a.linked_flag_id === "number" ? a.linked_flag_id : undefined,
          targeting_flag_id: typeof a.targeting_flag_id === "number" ? a.targeting_flag_id : undefined,
          conditions: a.conditions && typeof a.conditions === "object" ? (a.conditions as Record<string, unknown>) : undefined,
          appearance: a.appearance && typeof a.appearance === "object" ? (a.appearance as Record<string, unknown>) : undefined,
          start_date: a.start_date ? String(a.start_date) : undefined,
        });
      case "agentry_delete_survey":
        return await handleDeleteSurvey({
          project_id: a.project_id ? String(a.project_id) : undefined,
          survey_id: String(a.survey_id ?? ""),
        });
      case "agentry_list_session_replays":
        return await handleListSessionReplays({
          project_id: a.project_id ? String(a.project_id) : undefined,
          distinct_id: a.distinct_id ? String(a.distinct_id) : undefined,
          date_from: a.date_from ? String(a.date_from) : undefined,
          date_to: a.date_to ? String(a.date_to) : undefined,
          limit: typeof a.limit === "number" ? a.limit : undefined,
        });
      case "agentry_get_session_replay":
        return await handleGetSessionReplay({
          project_id: a.project_id ? String(a.project_id) : undefined,
          replay_id: String(a.replay_id ?? ""),
        });
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
      case "agentry_unmangle_stack":
        return await handleUnmangleStack({
          case_id: String(a.case_id ?? ""),
          event_id: a.event_id ? String(a.event_id) : undefined,
          release_id: a.release_id ? String(a.release_id) : undefined,
        });
      case "agentry_upload_sourcemap":
        return await handleUploadSourcemap({
          project_id: a.project_id ? String(a.project_id) : undefined,
          map_file_path: String(a.map_file_path ?? ""),
          source_url: String(a.source_url ?? ""),
          release_id: a.release_id ? String(a.release_id) : undefined,
        });
      case "agentry_list_sourcemaps":
        return await handleListSourcemaps({
          project_id: a.project_id ? String(a.project_id) : undefined,
          release_id: a.release_id ? String(a.release_id) : undefined,
        });
      case "agentry_delete_sourcemaps":
        return await handleDeleteSourcemaps({
          project_id: a.project_id ? String(a.project_id) : undefined,
          release_id: String(a.release_id ?? ""),
        });
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
      case "agentry_record_deploy":
        return await handleRecordDeploy({
          project_id: a.project_id ? String(a.project_id) : undefined,
          sha: String(a.sha ?? ""),
          branch: a.branch ? String(a.branch) : undefined,
          environment: a.environment ? String(a.environment) : undefined,
          message: a.message ? String(a.message) : undefined,
          url: a.url ? String(a.url) : undefined,
          actor: a.actor ? String(a.actor) : undefined,
        });
      case "agentry_list_deploys":
        return await handleListDeploys({
          project_id: a.project_id ? String(a.project_id) : undefined,
          limit: typeof a.limit === "number" ? a.limit : undefined,
          since: typeof a.since === "number" ? a.since : undefined,
        });
      case "agentry_track_test_event":
        return await handleTrackTestEvent({
          project_id: a.project_id ? String(a.project_id) : undefined,
          event: a.event ? String(a.event) : "agentry_verify",
        });
      case "agentry_analytics_query":
        return await handleAnalyticsQuery({
          project_id: a.project_id ? String(a.project_id) : undefined,
          query: String(a.query ?? ""),
        });
      case "agentry_install_guide":
        return await handleInstallGuide({
          framework: a.framework ? String(a.framework) : "node",
          signal_types: Array.isArray(a.signal_types)
            ? (a.signal_types as unknown[]).map(String)
            : ["errors", "analytics", "deploys"],
        });
      case "agentry_verify_install":
        return await handleVerifyInstall({
          project_id: a.project_id ? String(a.project_id) : undefined,
          skip: Array.isArray(a.skip) ? (a.skip as unknown[]).map(String) : [],
        });
      case "agentry_list_recipes":
        return await handleListRecipes(a.category ? String(a.category) : undefined);
      case "agentry_run_recipe":
        return await handleRunRecipe({
          recipe_id: String(a.recipe_id ?? ""),
          project_id: a.project_id ? String(a.project_id) : undefined,
          params: a.params && typeof a.params === "object"
            ? (a.params as Record<string, unknown>)
            : {},
        });
      case "agentry_query_docs":
        return await handleQueryDocs();
      case "agentry_suggested_next_steps":
        return await handleSuggestedNextSteps(
          a.project_id ? String(a.project_id) : undefined,
        );
      case "agentry_project_health":
        return await handleProjectHealth(a.project_id ? String(a.project_id) : undefined);
      case "agentry_create_alert":
        return await handleCreateAlert({
          name: String(a.name ?? ""),
          recipe_id: String(a.recipe_id ?? ""),
          threshold_column: String(a.threshold_column ?? ""),
          threshold_op: String(a.threshold_op ?? ""),
          threshold_value: typeof a.threshold_value === "number" ? a.threshold_value : Number(a.threshold_value),
          params: a.params && typeof a.params === "object" ? (a.params as Record<string, unknown>) : {},
          description: a.description ? String(a.description) : undefined,
          webhook_id: a.webhook_id ? String(a.webhook_id) : undefined,
          project_id: a.project_id ? String(a.project_id) : undefined,
        });
      case "agentry_list_alerts":
        return await handleListAlerts(a.project_id ? String(a.project_id) : undefined);
      case "agentry_evaluate_alert":
        return await handleEvaluateAlert({
          alert_id: String(a.alert_id ?? ""),
          project_id: a.project_id ? String(a.project_id) : undefined,
        });
      case "agentry_delete_alert":
        return await handleDeleteAlert({
          alert_id: String(a.alert_id ?? ""),
          project_id: a.project_id ? String(a.project_id) : undefined,
        });
      case "agentry_remember":
        return await handleRemember({
          case_id: String(a.case_id ?? ""),
          summary: String(a.summary ?? ""),
          fingerprint: a.fingerprint ? String(a.fingerprint) : undefined,
          status: a.status ? String(a.status) : undefined,
          error_type: a.error_type ? String(a.error_type) : undefined,
          pr_url: a.pr_url ? String(a.pr_url) : undefined,
          watch_for: a.watch_for ? String(a.watch_for) : undefined,
          tags: Array.isArray(a.tags) ? (a.tags as unknown[]).map(String) : undefined,
          project_id: a.project_id ? String(a.project_id) : undefined,
        });
      case "agentry_recall":
        return handleRecall({
          case_id: a.case_id ? String(a.case_id) : undefined,
          project_id: a.project_id ? String(a.project_id) : undefined,
        });
      case "agentry_register_webhook":
        return await handleRegisterWebhook({
          url: String(a.url ?? ""),
          events: Array.isArray(a.events) ? (a.events as unknown[]).map(String) : undefined,
          description: a.description ? String(a.description) : undefined,
          project_id: a.project_id ? String(a.project_id) : undefined,
        });
      case "agentry_list_webhooks":
        return await handleListWebhooks(a.project_id ? String(a.project_id) : undefined);
      case "agentry_list_event_names":
        return await handleListEventNames(a.project_id ? String(a.project_id) : undefined);
      case "agentry_test_webhook":
        return await handleTestWebhook({
          webhook_id: String(a.webhook_id ?? ""),
          project_id: a.project_id ? String(a.project_id) : undefined,
        });
      case "agentry_delete_webhook":
        return await handleDeleteWebhook({
          webhook_id: String(a.webhook_id ?? ""),
          project_id: a.project_id ? String(a.project_id) : undefined,
        });
      case "agentry_automation_docs":
        return await handleAutomationDocs();
      case "agentry_send_feedback":
        return await handleSendFeedback({
          kind: String(a.kind ?? "other") as never,
          message: String(a.message ?? ""),
          agent_note: a.agent_note ? String(a.agent_note) : undefined,
          tool_name: a.tool_name ? String(a.tool_name) : undefined,
          attempt_count: typeof a.attempt_count === "number" ? a.attempt_count : undefined,
          project_id: a.project_id ? String(a.project_id) : undefined,
          claude_session_id: a.claude_session_id ? String(a.claude_session_id) : undefined,
        });
      case "agentry_list_feedback":
        return await handleListFeedback({
          limit: typeof a.limit === "number" ? a.limit : undefined,
          kind: a.kind ? String(a.kind) : undefined,
          resolved: typeof a.resolved === "boolean" ? a.resolved : undefined,
        });
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

async function handleLogin(input: {
  mode: "full" | "start_only" | "poll_once";
  device_code?: string;
  timeout_seconds?: number;
}): Promise<ToolResult> {
  const cfg = loadConfig();

  if (input.mode === "start_only") {
    const start = await api.startDeviceFlow(cfg);
    return {
      mode: "start_only",
      verification_uri: start.verification_uri,
      user_code: start.user_code,
      device_code: start.device_code,
      interval: start.interval,
      expires_in: start.expires_in,
      next_action:
        `Show the user: "Open ${start.verification_uri} and enter the code ${start.user_code}." ` +
        `Then IMMEDIATELY call agentry_login again with mode='full' and device_code='${start.device_code}'. ` +
        `That call will block and auto-poll for up to ${start.expires_in}s — DO NOT ask the user to confirm authorization before polling.`,
    };
  }

  if (input.mode === "poll_once") {
    if (!input.device_code) {
      return {
        error: {
          code: "missing_device_code",
          message: "mode='poll_once' requires device_code from the start_only call.",
          next_action:
            "Either call agentry_login with mode='start_only' first, or use mode='full' and let the tool handle the loop.",
        },
      };
    }
    const result = await api.pollDeviceFlow(cfg, input.device_code);
    if ("api_key" in result) {
      const next = persistKeyResponse(cfg, result);
      return {
        ok: true,
        user_id: result.user_id,
        github: result.github,
        api_key_prefix: result.prefix,
        persisted_to: "local config",
        server_url: next.server_url,
        next_action:
          "Authenticated. Call `agentry_create_project` with a project name (and local_path of the repo) to mint a DSN.",
      };
    }
    return {
      ok: false,
      status: result.status,
      next_action:
        result.next_action ??
        "Wait and call agentry_login again with mode='poll_once' and the same device_code.",
    };
  }

  // mode === "full" — either start a fresh flow, OR poll an existing one if
  // the agent already showed the user the code via a prior start_only call.
  // The latter is the recommended interactive pattern: start_only → show code
  // → full(device_code) blocks-and-polls automatically. No "tell me when done."
  let verificationUri: string;
  let userCode: string;
  let deviceCode: string;
  let intervalMs: number;
  if (input.device_code) {
    deviceCode = input.device_code;
    verificationUri = "";
    userCode = "";
    intervalMs = 5000; // safe default; we don't have the start response here
  } else {
    const start = await api.startDeviceFlow(cfg);
    deviceCode = start.device_code;
    verificationUri = start.verification_uri;
    userCode = start.user_code;
    intervalMs = Math.max(1, start.interval) * 1000;
  }
  const deadline = Date.now() + (input.timeout_seconds ?? 300) * 1000;

  let lastStatus: string | null = null;
  while (Date.now() < deadline) {
    const result = await api.pollDeviceFlow(cfg, deviceCode);
    if ("api_key" in result) {
      const next = persistKeyResponse(cfg, result);
      return {
        ok: true,
        user_id: result.user_id,
        github: result.github,
        api_key_prefix: result.prefix,
        persisted_to: "local config",
        server_url: next.server_url,
        ...(verificationUri ? { verification_uri_used: verificationUri } : {}),
        ...(userCode ? { user_code_used: userCode } : {}),
        next_action:
          "Authenticated. Call `agentry_create_project` with a project name (and local_path of the repo) to mint a DSN.",
      };
    }
    lastStatus = result.status;
    if (result.status === "expired" || result.status === "denied") {
      return {
        ok: false,
        status: result.status,
        ...(verificationUri ? { verification_uri: verificationUri } : {}),
        ...(userCode ? { user_code: userCode } : {}),
        next_action:
          result.next_action ??
          (result.status === "expired"
            ? "Device code expired. Call `agentry_login` again to start a fresh flow."
            : "User declined. Confirm with them and call `agentry_login` again if they want to proceed."),
      };
    }
    const delay = result.status === "slow_down" ? intervalMs + 5000 : intervalMs;
    await sleep(delay);
  }
  return {
    ok: false,
    status: "timeout",
    last_status: lastStatus,
    ...(verificationUri ? { verification_uri: verificationUri } : {}),
    ...(userCode ? { user_code: userCode } : {}),
    device_code: deviceCode,
    next_action:
      `Timed out after ${input.timeout_seconds ?? 300}s. ` +
      (verificationUri && userCode
        ? `Confirm the user opened ${verificationUri} and entered ${userCode}, `
        : "Confirm the user has authorized, ") +
      `then call agentry_login again with mode='full' and device_code='${deviceCode}' to resume polling.`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function handleRotateKey(): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: {
        code: "no_key",
        message: "No API key to rotate.",
        next_action: "Call `agentry_login` to authenticate via GitHub first.",
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

async function handleRepairAnalytics(): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: {
        code: "no_key",
        message: "No API key on file — can't repair anything for an unauthenticated session.",
        next_action: "Call `agentry_login` first.",
      },
    };
  }
  try {
    const resp = await api.repairAnalyticsBackend(cfg);
    return resp;
  } catch (err) {
    return {
      error: {
        code: "repair_failed",
        message: err instanceof Error ? err.message : String(err),
        next_action:
          "Upstream PostHog provisioning failed. If the error mentions 5xx / timeouts / rate " +
          "limits, wait 30–60s and call agentry_repair_analytics again. Errors and deploys are " +
          "unaffected; only analytics ingest needs PostHog.",
      },
    };
  }
}

async function handlePublishQuery(input: {
  project_id?: string;
  recipe_id: string;
  params?: Record<string, unknown>;
  description?: string;
}): Promise<ToolResult> {
  const cfg = loadConfig();
  const picked = pickProject(cfg, input.project_id);
  if (!picked) {
    return {
      error: {
        code: "no_project",
        message: "No project_id given and no default project set.",
        next_action: "Pass project_id, or call agentry_create_project.",
      },
    };
  }
  const resp = await api.publishQuery(cfg, picked.id, {
    recipe_id: input.recipe_id,
    params: input.params,
    description: input.description,
  });
  // Help the agent: fetch the user's agp_ key from the local config and
  // append it as a query param to the public URL.
  const agp =
    (cfg as unknown as { public_api_key?: string }).public_api_key ?? null;
  const embeddableUrl = agp ? `${resp.public_url}?key=${agp}` : resp.public_url;
  return {
    ...resp,
    embeddable_url: embeddableUrl,
    next_action: agp
      ? "Embed embeddable_url in the public dashboard. CORS is open. Revoke any time with " +
        "agentry_revoke_publication if it's leaked or no longer needed."
      : "Your agp_ public key isn't cached locally yet — call agentry_login to mint it. Once " +
        "minted, paste it as ?key=<agp_…> on the public_url to embed.",
  };
}

async function handleListPublications(projectId?: string): Promise<ToolResult> {
  const cfg = loadConfig();
  const picked = pickProject(cfg, projectId);
  if (!picked) {
    return {
      error: {
        code: "no_project",
        message: "No project_id given and no default project set.",
        next_action: "Pass project_id.",
      },
    };
  }
  return await api.listPublications(cfg, picked.id);
}

async function handleRevokePublication(input: {
  project_id?: string;
  publication_id: string;
}): Promise<ToolResult> {
  const cfg = loadConfig();
  const picked = pickProject(cfg, input.project_id);
  if (!picked) {
    return {
      error: {
        code: "no_project",
        message: "No project_id given and no default project set.",
        next_action: "Pass project_id.",
      },
    };
  }
  return await api.revokePublication(cfg, picked.id, input.publication_id);
}

async function handleConfigureSessionReplay(input: {
  project_id?: string;
  strategy: "off" | "all" | "sampled" | "url_scoped" | "errors_only";
  sample_rate?: number;
  retention_days?: number;
  min_duration_ms?: number;
  url_triggers?: Array<{ url: string; matching?: string }>;
}): Promise<ToolResult> {
  const cfg = loadConfig();
  const picked = pickProject(cfg, input.project_id);
  if (!picked) {
    return {
      error: {
        code: "no_project",
        message: "No project_id given and no default project set.",
        next_action: "Pass project_id, or call agentry_create_project.",
      },
    };
  }
  return await api.configureSessionReplay(cfg, picked.id, {
    strategy: input.strategy,
    sample_rate: input.sample_rate,
    retention_days: input.retention_days,
    min_duration_ms: input.min_duration_ms,
    url_triggers: input.url_triggers as Array<{ url: string; matching?: "exact" | "regex" }> | undefined,
  });
}

async function handleSessionReplayStatus(projectId?: string): Promise<ToolResult> {
  const cfg = loadConfig();
  const picked = pickProject(cfg, projectId);
  if (!picked) {
    return {
      error: {
        code: "no_project",
        message: "No project_id given and no default project set.",
        next_action: "Pass project_id, or call agentry_create_project.",
      },
    };
  }
  return await api.getSessionReplayStatus(cfg, picked.id);
}

// ---------------------------------------------------------------------------
// PostHog per-user-team CRUD handlers.
// Shared helper for the "no project" error envelope to keep handlers terse.
// ---------------------------------------------------------------------------

function pickOrError(
  cfg: AgentryConfig,
  projectId: string | undefined,
): { ok: true; id: string } | { ok: false; error: ToolResult } {
  const picked = pickProject(cfg, projectId);
  if (!picked) {
    return {
      ok: false,
      error: {
        error: {
          code: "no_project",
          message: "No project_id given and no default project set.",
          next_action: "Pass project_id, or call agentry_create_project.",
        },
      },
    };
  }
  return { ok: true, id: picked.id };
}

async function handleListFeatureFlags(input: {
  project_id?: string;
  limit?: number;
}): Promise<ToolResult> {
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  return await api.listFeatureFlags(cfg, r.id, { limit: input.limit });
}

async function handleGetFeatureFlag(input: {
  project_id?: string;
  flag_id: string;
}): Promise<ToolResult> {
  if (!input.flag_id) {
    return { error: { code: "invalid_payload", message: "flag_id is required.", next_action: "Pass flag_id (numeric, from agentry_list_feature_flags)." } };
  }
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  return await api.getFeatureFlag(cfg, r.id, input.flag_id);
}

async function handleCreateFeatureFlag(input: {
  project_id?: string;
  key: string;
  name?: string;
  active?: boolean;
  rollout_percentage?: number;
  filters?: Record<string, unknown>;
}): Promise<ToolResult> {
  if (!input.key) {
    return { error: { code: "invalid_payload", message: "key is required.", next_action: "Pass key (slug, e.g. 'new-checkout-flow')." } };
  }
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  return await api.createFeatureFlag(cfg, r.id, {
    key: input.key,
    name: input.name,
    active: input.active,
    rollout_percentage: input.rollout_percentage,
    filters: input.filters,
  });
}

async function handleUpdateFeatureFlag(input: {
  project_id?: string;
  flag_id: string;
  active?: boolean;
  name?: string;
  rollout_percentage?: number;
  filters?: Record<string, unknown>;
}): Promise<ToolResult> {
  if (!input.flag_id) {
    return { error: { code: "invalid_payload", message: "flag_id is required.", next_action: "Pass flag_id (numeric)." } };
  }
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  return await api.updateFeatureFlag(cfg, r.id, input.flag_id, {
    active: input.active,
    name: input.name,
    rollout_percentage: input.rollout_percentage,
    filters: input.filters,
  });
}

async function handleDeleteFeatureFlag(input: {
  project_id?: string;
  flag_id: string;
}): Promise<ToolResult> {
  if (!input.flag_id) {
    return { error: { code: "invalid_payload", message: "flag_id is required.", next_action: "Pass flag_id (numeric)." } };
  }
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  return await api.deleteFeatureFlag(cfg, r.id, input.flag_id);
}

async function handleListCohorts(projectId?: string): Promise<ToolResult> {
  const cfg = loadConfig();
  const r = pickOrError(cfg, projectId);
  if (!r.ok) return r.error;
  return await api.listCohorts(cfg, r.id);
}

async function handleGetCohort(input: {
  project_id?: string;
  cohort_id: string;
}): Promise<ToolResult> {
  if (!input.cohort_id) {
    return { error: { code: "invalid_payload", message: "cohort_id is required.", next_action: "Pass cohort_id (numeric)." } };
  }
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  return await api.getCohort(cfg, r.id, input.cohort_id);
}

async function handleCreateCohort(input: {
  project_id?: string;
  name: string;
  event?: string;
  days?: number;
  groups?: Array<Record<string, unknown>>;
}): Promise<ToolResult> {
  if (!input.name) {
    return { error: { code: "invalid_payload", message: "name is required.", next_action: "Pass cohort name." } };
  }
  if (!input.event && (!input.groups || input.groups.length === 0)) {
    return {
      error: {
        code: "invalid_payload",
        message: "Cohort body must include 'event' (simple shape) or 'groups' (advanced shape).",
        next_action: "Pass event='signup_completed' (last N days) or pass groups: [...PostHog filter format].",
      },
    };
  }
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  const body = input.groups
    ? { name: input.name, groups: input.groups }
    : { name: input.name, event: input.event as string, days: input.days };
  return await api.createCohort(cfg, r.id, body);
}

async function handleDeleteCohort(input: {
  project_id?: string;
  cohort_id: string;
}): Promise<ToolResult> {
  if (!input.cohort_id) {
    return { error: { code: "invalid_payload", message: "cohort_id is required.", next_action: "Pass cohort_id (numeric)." } };
  }
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  return await api.deleteCohort(cfg, r.id, input.cohort_id);
}

async function handleListSurveys(projectId?: string): Promise<ToolResult> {
  const cfg = loadConfig();
  const r = pickOrError(cfg, projectId);
  if (!r.ok) return r.error;
  return await api.listSurveys(cfg, r.id);
}

async function handleGetSurvey(input: {
  project_id?: string;
  survey_id: string;
}): Promise<ToolResult> {
  if (!input.survey_id) {
    return { error: { code: "invalid_payload", message: "survey_id is required.", next_action: "Pass survey_id." } };
  }
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  return await api.getSurvey(cfg, r.id, input.survey_id);
}

async function handleCreateSurvey(input: {
  project_id?: string;
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
}): Promise<ToolResult> {
  if (!input.name) {
    return { error: { code: "invalid_payload", message: "name is required.", next_action: "Pass survey name." } };
  }
  if (!input.question && (!input.questions || input.questions.length === 0)) {
    return {
      error: {
        code: "invalid_payload",
        message: "Survey must include 'question' (simple) or 'questions' (multi).",
        next_action: "Pass question='How likely are you to recommend us?' OR questions: [{type, question}, ...]",
      },
    };
  }
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  return await api.createSurvey(cfg, r.id, {
    name: input.name,
    type: input.type,
    question: input.question,
    question_type: input.question_type,
    questions: input.questions,
    description: input.description,
    linked_flag_id: input.linked_flag_id,
    targeting_flag_id: input.targeting_flag_id,
    conditions: input.conditions,
    appearance: input.appearance,
    start_date: input.start_date,
  });
}

async function handleDeleteSurvey(input: {
  project_id?: string;
  survey_id: string;
}): Promise<ToolResult> {
  if (!input.survey_id) {
    return { error: { code: "invalid_payload", message: "survey_id is required.", next_action: "Pass survey_id." } };
  }
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  return await api.deleteSurvey(cfg, r.id, input.survey_id);
}

async function handleListSessionReplays(input: {
  project_id?: string;
  distinct_id?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}): Promise<ToolResult> {
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  return await api.listSessionReplays(cfg, r.id, {
    distinctId: input.distinct_id,
    dateFrom: input.date_from,
    dateTo: input.date_to,
    limit: input.limit,
  });
}

async function handleGetSessionReplay(input: {
  project_id?: string;
  replay_id: string;
}): Promise<ToolResult> {
  if (!input.replay_id) {
    return { error: { code: "invalid_payload", message: "replay_id is required.", next_action: "Pass replay_id from agentry_list_session_replays." } };
  }
  const cfg = loadConfig();
  const r = pickOrError(cfg, input.project_id);
  if (!r.ok) return r.error;
  return await api.getSessionReplay(cfg, r.id, input.replay_id);
}

async function handleListProjects(): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: {
        code: "no_key",
        message: "No API key on file.",
        next_action: "Call `agentry_login` first.",
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
        next_action: "Call `agentry_login` first.",
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
      // First-party typed endpoints — agent should prefer these over /v1/log/.
      // Same DSN authenticates all three. POST any-language HTTP client; no SDK.
      logs_url: resp.logs_url,
      analytics_url: resp.analytics_url,
      deploys_url: resp.deploys_url,
    },
    install_snippet: install,
    next_action:
      resp.next_action ??
      "DSN stored locally. Three typed endpoints (logs_url / analytics_url / deploys_url) " +
      "all authenticate with this DSN. Paste the install snippet, set AGENTRY_DSN, then call " +
      "`agentry_capture_test_event` to verify ingest.",
  };
}

async function handleInstallSdk(language: string): Promise<ToolResult> {
  const cfg = loadConfig();
  const lang = (language || "node").toLowerCase();
  // Node has a first-party typed SDK — return that directly.
  try {
    const resp = await api.getInstallSnippet(cfg, lang);
    return {
      language: resp.language,
      code: resp.code,
      env_vars: resp.env_vars,
      next_action:
        "Paste `code` into the user's project, then set the env_vars (AGENTRY_DSN especially). " +
        "Then call `agentry_capture_test_event` to verify ingest.",
    };
  } catch (err) {
    // No first-party SDK for this language — fall back to the framework guide,
    // which always includes a working DSN/HTTP path. Every HTTP-capable runtime
    // is supported by design; the agent should NOT tell the user it isn't.
    const status = (err as { status?: number }).status;
    if (status !== 404) throw err;
    const guide = await api.getInstallGuide(cfg, lang).catch(() => null);
    if (guide) {
      return {
        language: lang,
        approach: "dsn_http",
        note:
          `No typed SDK for ${lang} — using the DSN/HTTP path. The ingest endpoint is plain HTTP, ` +
          `so any runtime that can POST JSON is fully supported.`,
        guide,
        next_action:
          "Walk the customer through `guide.steps` in order. After they paste the DSN env var and " +
          "wire the error handler, call `agentry_capture_test_event` to confirm ingest works.",
      };
    }
    // Last-resort generic snippet — keeps the tool useful even if the API is degraded.
    return {
      language: lang,
      approach: "dsn_http",
      note:
        `Use the DSN/HTTP path. Any runtime that can POST JSON works; ${lang} has no first-party SDK ` +
        `but the ingest endpoint is plain HTTP.`,
      env_vars: { AGENTRY_DSN: "<from agentry_create_project or dashboard>" },
      next_action:
        "Call `agentry_install_guide` with the detected framework to get an ordered checklist, " +
        "then `agentry_capture_test_event` to verify.",
    };
  }
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
        next_action: "Call `agentry_login` first.",
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

// Translate minified stack frames using sourcemaps stored in agentry. The
// .map blobs live in agentry's R2; this handler fetches them via the DSN-auth
// blob endpoint and runs @jridgewell/trace-mapping locally in the MCP process.
//
// agentry's role: storage + retrieval. Translation is the agent's job.
// "Agent" includes the MCP process the user runs locally — the code below is
// what npm-installs into ~/.npm/_npx/.../node_modules/@agentrysh/mcp/dist/
// and is fully reviewable. No hidden server-side magic.
//
// The result includes a `code_snippet` showing the exact lines that produced
// the translation, the library version, and the source_urls of the .maps
// fetched — so an agent or human can reproduce it with the same library and
// the same map.
async function handleUnmangleStack(input: {
  case_id: string;
  event_id?: string;
  release_id?: string;
}): Promise<ToolResult> {
  if (!input.case_id) {
    return {
      error: {
        code: "missing_case_id",
        message: "case_id is required",
        next_action:
          "Pass case_id from agentry_get_case. The minified stack(s) on its " +
          "recent_events[] are what get translated.",
      },
    };
  }
  // Dynamic import keeps trace-mapping out of the cold-start path of every
  // other tool. Most tool calls won't ever touch sourcemap translation.
  const { TraceMap, originalPositionFor } = await import("@jridgewell/trace-mapping");

  const cfg = loadConfig();
  const detail = await api.getCase(cfg, input.case_id);
  const projectId = detail.project_id;
  const dsn = lookupDsn(cfg, projectId);
  if (!dsn) {
    return {
      error: {
        code: "no_dsn",
        message: `No DSN cached locally for project ${projectId}`,
        next_action:
          "agentry_unmangle_stack uses the project DSN (not the api_key) to fetch sourcemap " +
          "blobs from /v1/sourcemaps/. Re-run agentry_create_project for this project to " +
          "re-cache the DSN, or call agentry_list_projects to inspect what's stored.",
      },
    };
  }

  // Per-handler memoization: one .map per (release_id, source_url) — many
  // frames will share the same chunk file, no point fetching twice.
  const mapCache = new Map<string, InstanceType<typeof TraceMap> | null>();

  const eventsToProcess = input.event_id
    ? detail.recent_events.filter((e) => e.id === input.event_id)
    : detail.recent_events;

  const sourcemapsUsed = new Set<string>();
  let translatedFrameCount = 0;
  let pendingFrameCount = 0;

  const translated = await Promise.all(
    eventsToProcess.map(async (ev) => {
      const releaseId = input.release_id ?? ev.deploy_sha ?? "default";
      const newStack = await Promise.all(
        (ev.stack ?? []).map(async (frame) => {
          const src = normalizeSourceUrl(frame.filename);
          if (!src || frame.lineno == null) {
            pendingFrameCount++;
            return { ...frame, unmangled: false };
          }
          const cacheKey = `${releaseId} ${src}`;
          let map = mapCache.get(cacheKey);
          if (map === undefined) {
            const raw = await api
              .getSourcemapBlob(cfg, projectId, dsn, {
                releaseId,
                sourceUrl: src,
              })
              .catch(() => null);
            if (!raw) {
              map = null;
              mapCache.set(cacheKey, null);
            } else {
              try {
                map = new TraceMap(JSON.parse(raw));
                sourcemapsUsed.add(src);
                mapCache.set(cacheKey, map);
              } catch {
                map = null;
                mapCache.set(cacheKey, null);
              }
            }
          }
          if (!map) {
            pendingFrameCount++;
            return { ...frame, unmangled: false };
          }
          const original = originalPositionFor(map, {
            line: frame.lineno,
            column: frame.colno ?? 0,
          });
          if (original.source == null) {
            pendingFrameCount++;
            return { ...frame, unmangled: false };
          }
          translatedFrameCount++;
          return {
            ...frame,
            original_file: original.source,
            original_line: original.line ?? undefined,
            original_column: original.column ?? undefined,
            original_name: original.name ?? undefined,
            unmangled: true,
          };
        }),
      );
      return { ...ev, stack: newStack };
    }),
  );

  return {
    case_id: input.case_id,
    events: translated,
    library: "@jridgewell/trace-mapping@^0.3.25",
    sourcemaps_used: [...sourcemapsUsed],
    summary: {
      events_processed: eventsToProcess.length,
      frames_translated: translatedFrameCount,
      frames_passthrough: pendingFrameCount,
    },
    code_snippet:
      "// This is the exact translation logic running in @agentrysh/mcp.\n" +
      "// You can paste it into scripts/unmangle.ts in your repo and run it\n" +
      "// against the .map you fetched from /v1/sourcemaps/.../blob.\n" +
      "import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';\n" +
      "\n" +
      "// agentry's stack frames use Sentry's shape: filename / lineno / colno.\n" +
      "function unmangle(rawMapJson: string, frame: { filename: string; lineno: number; colno?: number }) {\n" +
      "  const map = new TraceMap(JSON.parse(rawMapJson));\n" +
      "  return originalPositionFor(map, { line: frame.lineno, column: frame.colno ?? 0 });\n" +
      "}",
    next_action:
      translatedFrameCount > 0
        ? "Read each frame's `original_file` + `original_line` in the local repo (cd to case.local_path " +
          "and open the file). Frames with `unmangled: false` either had no sourcemap uploaded for that " +
          "source_url, or the sourcemap didn't have a mapping for that exact line:column. Confirm the " +
          "sourcemap upload step ran for the release_id (deploy SHA) that emitted this error."
        : "No frames translated. Either (a) no sourcemaps were uploaded for this release_id, or " +
          "(b) the source_urls on the stack don't match any uploaded map paths. Check " +
          "agentry_list_projects + curl GET /v1/sourcemaps/<project_id>/ to see what's stored.",
  };
}

// Strip protocol / host / query from a stack-frame `file` URL so it matches
// uploaded `source_url` keys (which are pathnames). Stack traces from a CDN
// look like https://cdn.app.com/static/chunks/abc.js?v=1; the upload was for
// path /static/chunks/abc.js.
function normalizeSourceUrl(file: string | undefined | null): string | null {
  if (!file) return null;
  try {
    return new URL(file).pathname;
  } catch {
    return file.replace(/[?#].*$/, "");
  }
}

// Look up the DSN cached locally for a given project (stored at config save
// time by agentry_create_project / agentry_list_projects). The DSN — not the
// api_key — is what authenticates sourcemap blob fetches.
function lookupDsn(cfg: ReturnType<typeof loadConfig>, projectId: string): string | null {
  return cfg.projects?.[projectId]?.dsn ?? null;
}

// MCP wrappers over POST/GET/DELETE /v1/sourcemaps/. Provided for parity with
// the HTTP API — every storage op exposed via curl is also exposed as an MCP
// tool so agents don't have to drop to bash for ad-hoc uploads. Translation
// stays MCP-only (agentry_unmangle_stack) because the code that runs should
// be auditable, not server-side.

async function handleUploadSourcemap(input: {
  project_id?: string;
  map_file_path: string;
  source_url: string;
  release_id?: string;
}): Promise<ToolResult> {
  if (!input.map_file_path) {
    return {
      error: {
        code: "missing_map_file_path",
        message: "map_file_path is required",
        next_action: "Pass an absolute path to the .map file (typically under dist/, .next/, etc).",
      },
    };
  }
  if (!input.source_url) {
    return {
      error: {
        code: "missing_source_url",
        message: "source_url is required",
        next_action:
          "Pass the pathname the minified .js is served at (e.g. /_next/static/chunks/abc.js). " +
          "Must match what the browser reports in stack-frame `filename` for lookup to work.",
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
        next_action:
          "Either pass project_id, or call agentry_create_project to mint one (which becomes default).",
      },
    };
  }
  const dsn = lookupDsn(cfg, picked.id);
  if (!dsn) {
    return {
      error: {
        code: "no_dsn",
        message: `No DSN cached locally for project ${picked.id}`,
        next_action:
          "Re-run agentry_create_project for this project to re-cache the DSN.",
      },
    };
  }
  // Use dynamic import so MCP cold-start for non-sourcemap tools doesn't pay
  // for node:fs even though it's free in CommonJS land.
  const fs = await import("node:fs");
  let body: string;
  try {
    body = fs.readFileSync(input.map_file_path, "utf8");
  } catch (err) {
    return {
      error: {
        code: "read_failed",
        message: `Could not read ${input.map_file_path}: ${(err as Error).message}`,
        next_action: "Verify the path exists and is readable. Use an absolute path.",
      },
    };
  }
  const resp = await api.uploadSourcemap(cfg, picked.id, dsn, {
    releaseId: input.release_id,
    sourceUrl: input.source_url,
    body,
  });
  return {
    ...resp,
    next_action:
      "Sourcemap stored. Confirm with agentry_list_sourcemaps; once you have errors with " +
      "matching deploy_sha, agentry_unmangle_stack will translate the minified frames.",
  };
}

async function handleListSourcemaps(input: {
  project_id?: string;
  release_id?: string;
}): Promise<ToolResult> {
  const cfg = loadConfig();
  const picked = pickProject(cfg, input.project_id);
  if (!picked) {
    return {
      error: {
        code: "no_project",
        message: "No project_id given and no default project set.",
        next_action:
          "Either pass project_id, or call agentry_create_project to mint one (which becomes default).",
      },
    };
  }
  const dsn = lookupDsn(cfg, picked.id);
  if (!dsn) {
    return {
      error: {
        code: "no_dsn",
        message: `No DSN cached locally for project ${picked.id}`,
        next_action:
          "Re-run agentry_create_project for this project to re-cache the DSN.",
      },
    };
  }
  const resp = await api.listSourcemaps(cfg, picked.id, dsn, {
    releaseId: input.release_id,
  });
  return {
    ...resp,
    next_action:
      resp.count === 0
        ? "No sourcemaps uploaded yet. Walk the install guide's upload_sourcemaps_for_minified_stacks " +
          "step to wire upload into CI, or use agentry_upload_sourcemap for an ad-hoc upload."
        : "Confirm the release_ids here match the deploy_sha on the cases you're investigating. " +
          "If they don't, the agent_unmangle_stack tool will return frames with `unmangled: false`.",
  };
}

async function handleDeleteSourcemaps(input: {
  project_id?: string;
  release_id: string;
}): Promise<ToolResult> {
  if (!input.release_id) {
    return {
      error: {
        code: "missing_release_id",
        message: "release_id is required — refuses to bulk-delete a project's sourcemaps.",
        next_action: "Pass the specific release_id you want cleaned up.",
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
        next_action: "Pass project_id explicitly.",
      },
    };
  }
  const dsn = lookupDsn(cfg, picked.id);
  if (!dsn) {
    return {
      error: {
        code: "no_dsn",
        message: `No DSN cached locally for project ${picked.id}`,
        next_action: "Re-run agentry_create_project for this project to re-cache the DSN.",
      },
    };
  }
  const resp = await api.deleteSourcemaps(cfg, picked.id, dsn, {
    releaseId: input.release_id,
  });
  return {
    ...resp,
    next_action:
      "Sourcemaps for that release_id removed. Cases pinned to that deploy_sha will no longer " +
      "translate. Verify with agentry_list_sourcemaps.",
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

// ---------------------------------------------------------------------------
// Deploy events
// ---------------------------------------------------------------------------

async function handleRecordDeploy(input: {
  project_id?: string;
  sha: string;
  branch?: string;
  environment?: string;
  message?: string;
  url?: string;
  actor?: string;
}): Promise<ToolResult> {
  if (!input.sha) {
    return {
      error: {
        code: "missing_sha",
        message: "sha is required",
        next_action: "Pass the git SHA of the deployed commit.",
      },
    };
  }
  const cfg = loadConfig();
  const r = requireProjectFromConfig(cfg, input.project_id);
  if ("error" in r) return r.error;

  const parsed = parseDsn(r.project.dsn);
  if (!parsed) {
    return {
      error: {
        code: "bad_dsn",
        message: `Stored DSN for project ${r.id} is not parseable.`,
        next_action: "Recreate the project via agentry_create_project.",
      },
    };
  }

  const resp = await api.recordDeploy(cfg, parsed.projectId, r.project.dsn, {
    sha: input.sha,
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
  });
  return {
    ok: true,
    deploy_id: resp.id,
    received_at: resp.received_at,
    next_action:
      "Deploy recorded. Future cases ingested after this timestamp will surface this deploy in their recent_deploys.",
  };
}

async function handleListDeploys(input: {
  project_id?: string;
  limit?: number;
  since?: number;
}): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: {
        code: "no_key",
        message: "No API key on file.",
        next_action: "Call `agentry_login` first.",
      },
    };
  }
  const projectId = input.project_id ?? cfg.default_project_id;
  if (!projectId) {
    return {
      error: {
        code: "no_project",
        message: "No project specified and no default project set.",
        next_action: "Pass project_id, or set a default by creating a project.",
      },
    };
  }
  const optsArg: { limit?: number; since?: number } = {};
  if (input.limit !== undefined) optsArg.limit = input.limit;
  if (input.since !== undefined) optsArg.since = input.since;
  const resp = await api.listDeploys(cfg, projectId, optsArg);
  return {
    project_id: projectId,
    ...resp,
    next_action:
      "Cross-reference deploy received_at with case last_seen_at to attribute regressions.",
  };
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

async function handleTrackTestEvent(input: {
  project_id?: string;
  event: string;
}): Promise<ToolResult> {
  const cfg = loadConfig();
  const r = requireProjectFromConfig(cfg, input.project_id);
  if ("error" in r) return r.error;

  const parsed = parseDsn(r.project.dsn);
  if (!parsed) {
    return {
      error: {
        code: "bad_dsn",
        message: `Stored DSN for project ${r.id} is not parseable.`,
        next_action: "Recreate the project via agentry_create_project.",
      },
    };
  }
  const eventName = input.event || "agentry_verify";
  const resp = await api.trackEvent(cfg, parsed.projectId, r.project.dsn, {
    event: eventName,
    distinct_id: "agentry-mcp-test",
    properties: { source: "agentry_track_test_event", ts: Math.floor(Date.now() / 1000) },
  });
  return {
    ok: resp.ok ?? true,
    event: eventName,
    next_action:
      "Event forwarded to PostHog. Use agentry_analytics_query to verify it landed " +
      `(SELECT count() FROM events WHERE event='${eventName}' AND timestamp > now() - INTERVAL 5 MINUTE).`,
  };
}

async function handleAnalyticsQuery(input: {
  project_id?: string;
  query: string;
}): Promise<ToolResult> {
  if (!input.query) {
    return {
      error: {
        code: "missing_query",
        message: "query (HogQL) is required",
        next_action: "Pass a HogQL query string.",
      },
    };
  }
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: {
        code: "no_key",
        message: "No API key on file.",
        next_action: "Call `agentry_login` first.",
      },
    };
  }
  const projectId = input.project_id ?? cfg.default_project_id;
  if (!projectId) {
    return {
      error: {
        code: "no_project",
        message: "No project specified and no default project set.",
        next_action: "Pass project_id, or create a project.",
      },
    };
  }
  const resp = await api.analyticsQuery(cfg, projectId, input.query);
  return {
    project_id: projectId,
    ...resp,
    next_action:
      "Interpret the rows. If you suspect a regression, call agentry_list_deploys to see if a deploy correlates.",
  };
}

// ---------------------------------------------------------------------------
// Install guide + comprehensive verification
// ---------------------------------------------------------------------------

async function handleInstallGuide(input: {
  framework: string;
  signal_types: string[];
}): Promise<ToolResult> {
  const cfg = loadConfig();
  const guide = await api.getInstallGuide(cfg, input.framework);
  // Filter steps if signal_types is a strict subset.
  const wanted = new Set(input.signal_types);
  const filteredSteps = guide.steps.filter((s) => {
    // common + verify steps always shown
    if (
      ["install_sdk", "set_env_vars", "verify_install"].includes(s.id) ||
      s.action === "verify"
    ) return true;
    if (s.id.startsWith("init_") || s.id.includes("error") || s.id.includes("uncaught") ||
        s.id.includes("middleware") || s.id.includes("error_boundary"))
      return wanted.has("errors");
    if (s.id.startsWith("track_") || s.id.includes("analytics")) return wanted.has("analytics");
    if (s.id.startsWith("fire_deploy") || s.id.includes("deploy")) return wanted.has("deploys");
    return true;
  });
  return {
    ...guide,
    steps: filteredSteps,
    next_action:
      "Read each step in order. For 'edit' steps, find the file matching `file_hint` in the customer's repo " +
      "and apply `code`. For 'run' steps, execute `command`. After all steps, call agentry_verify_install — " +
      "that's the only proof the install actually works.",
  };
}

async function handleVerifyInstall(input: {
  project_id?: string;
  skip: string[];
}): Promise<ToolResult> {
  const cfg = loadConfig();
  const r = requireProjectFromConfig(cfg, input.project_id);
  if ("error" in r) return r.error;

  const skip = new Set(input.skip);
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  if (!skip.has("errors")) {
    try {
      const resp = await handleCaptureTestEvent(r.id);
      const ok = (resp as { ok?: boolean; case_id?: string | null; error?: unknown }).ok === true;
      checks.errors = {
        ok,
        detail: ok
          ? `synthetic error landed → case_id=${(resp as { case_id?: string | null }).case_id ?? "(pending)"}`
          : `failed: ${JSON.stringify((resp as { error?: unknown }).error ?? resp)}`,
      };
    } catch (err) {
      checks.errors = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  if (!skip.has("analytics")) {
    try {
      const resp = await handleTrackTestEvent({ project_id: r.id, event: "agentry_verify_install" });
      const ok = (resp as { ok?: boolean; error?: unknown }).ok === true;
      checks.analytics = {
        ok,
        detail: ok
          ? "synthetic analytics event forwarded to PostHog (verify with agentry_analytics_query if needed)"
          : `failed: ${JSON.stringify((resp as { error?: unknown }).error ?? resp)}`,
      };
    } catch (err) {
      checks.analytics = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  if (!skip.has("deploys")) {
    try {
      const resp = await handleRecordDeploy({
        project_id: r.id,
        sha: `agentry-verify-${Date.now().toString(36)}`,
        branch: "agentry-verify",
        environment: "agentry-verify",
        message: "synthetic deploy from agentry_verify_install",
      });
      const ok = (resp as { ok?: boolean }).ok === true;
      checks.deploys = {
        ok,
        detail: ok
          ? "synthetic deploy recorded"
          : `failed: ${JSON.stringify((resp as { error?: unknown }).error ?? resp)}`,
      };
    } catch (err) {
      checks.deploys = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  const passed = Object.entries(checks).filter(([, v]) => v.ok).map(([k]) => k);
  const failed = Object.entries(checks).filter(([, v]) => !v.ok).map(([k]) => k);

  // Mark install_verified locally so the onboarding state machine moves to "ready".
  if (failed.length === 0) {
    const updated = loadConfig();
    const proj = updated.projects[r.id];
    if (proj) {
      updated.projects[r.id] = { ...proj, install_verified: true };
      saveConfig(updated);
    }
  }

  // Pull in suggested next-steps so the agent can immediately surface a menu.
  let nextSuggestions: Array<{ title: string; description: string; prompt_template: string }> = [];
  if (failed.length === 0) {
    try {
      const ns = await api.getNextSteps(loadConfig(), r.id);
      nextSuggestions = ns.suggestions as Array<{
        title: string;
        description: string;
        prompt_template: string;
      }>;
    } catch {
      /* non-fatal */
    }
  }

  // Detect the specific PostHog-not-provisioned failure mode so we can point
  // the agent at the cheap fix (agentry_repair_analytics) instead of the
  // expensive one (re-run agentry_login + re-instrument everything).
  const analyticsDetail = checks.analytics?.detail ?? "";
  const noPosthogProject =
    !checks.analytics?.ok &&
    (analyticsDetail.includes("no_posthog_project") ||
      analyticsDetail.includes("user has no PostHog project provisioned"));

  const baseAction =
    failed.length === 0
      ? "Install verified. Errors land in agentry_list_cases; analytics flow to PostHog; deploys via agentry_list_deploys."
      : noPosthogProject && failed.length === 1
      ? "Analytics is the only failed signal AND the cause is missing PostHog provisioning " +
        "(first-login provisioning was best-effort and failed). Call agentry_repair_analytics " +
        "— it's idempotent and runs the same provisioning step. Then re-run agentry_verify_install. " +
        "DO NOT re-run agentry_login for this."
      : `Install incomplete. Failed signal types: ${failed.join(", ")}. ` +
        (noPosthogProject
          ? "Analytics failed because the user has no PostHog project provisioned — " +
            "call agentry_repair_analytics, then re-run verify. "
          : "") +
        "For each failed type, re-read its corresponding step in agentry_install_guide and fix.";

  return {
    ok: failed.length === 0,
    summary: `${passed.length}/${Object.keys(checks).length} signal types verified`,
    passed,
    failed,
    checks,
    suggested_next_steps: nextSuggestions,
    next_action:
      failed.length === 0 && nextSuggestions.length > 0
        ? baseAction +
          " Now offer the user this menu of post-install prompts:\n" +
          nextSuggestions
            .slice(0, 5)
            .map((s, i) => `  ${i + 1}. ${s.title} — ${s.description}`)
            .join("\n") +
          "\nWhen the user picks one, paste its `prompt_template` as their next prompt (or just execute the listed `uses`)."
        : baseAction,
  };
}

// ---------------------------------------------------------------------------
// Recipes / query docs
// ---------------------------------------------------------------------------

async function handleListRecipes(category?: string): Promise<ToolResult> {
  const cfg = loadConfig();
  const resp = await api.listRecipes(cfg, category);
  return {
    ...resp,
    next_action:
      "Pick a recipe whose `description` or `example_user_question` matches what the user asked. " +
      "Then call `agentry_run_recipe` with its id and params (defaults are filled in if omitted). " +
      "If nothing matches, call `agentry_query_docs` to compose ad-hoc HogQL via `agentry_analytics_query`.",
  };
}

async function handleRunRecipe(input: {
  recipe_id: string;
  project_id?: string;
  params: Record<string, unknown>;
}): Promise<ToolResult> {
  if (!input.recipe_id) {
    return {
      error: {
        code: "missing_recipe_id",
        message: "recipe_id is required",
        next_action: "Call `agentry_list_recipes` to see available recipes.",
      },
    };
  }
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: {
        code: "no_key",
        message: "No API key on file.",
        next_action: "Call `agentry_login` first.",
      },
    };
  }
  const projectId = input.project_id ?? cfg.default_project_id;
  if (!projectId) {
    return {
      error: {
        code: "no_project",
        message: "No project_id specified and no default project set.",
        next_action: "Pass project_id, or create a project first.",
      },
    };
  }
  const resp = await api.runRecipe(cfg, projectId, input.recipe_id, input.params);
  return {
    project_id: projectId,
    ...resp,
  };
}

async function handleQueryDocs(): Promise<ToolResult> {
  const cfg = loadConfig();
  const md = await api.getQueryDocs(cfg);
  return {
    docs_markdown: md,
    next_action:
      "Read the schema + HogQL primer. Compose your query, then call `agentry_analytics_query` " +
      "with project_id and the HogQL string. For errors/deploys, use the relevant recipe or typed endpoints.",
  };
}

async function handleSuggestedNextSteps(projectId?: string): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: {
        code: "no_key",
        message: "No API key on file.",
        next_action: "Call `agentry_login` first.",
      },
    };
  }
  const id = projectId ?? cfg.default_project_id;
  if (!id) {
    return {
      error: {
        code: "no_project",
        message: "No project specified and no default project set.",
        next_action: "Pass project_id, or create a project first.",
      },
    };
  }
  const resp = await api.getNextSteps(cfg, id);
  return {
    project_id: id,
    ...resp,
    next_action:
      "Surface these to the user as numbered options. Use this format:\n\n" +
      "  Now that you're set up, want to:\n" +
      "    1. <title> — <description>\n" +
      "    2. <title> — <description>\n" +
      "    3. <title> — <description>\n\n" +
      "When the user picks one, paste the matching `prompt_template` as the user's next prompt " +
      "(or just execute the listed `uses` directly).",
  };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function pickProjectId(cfg: AgentryConfig, projectId?: string): string | null {
  return projectId ?? cfg.default_project_id ?? null;
}

async function handleRegisterWebhook(input: {
  url: string;
  events?: string[];
  description?: string;
  project_id?: string;
}): Promise<ToolResult> {
  if (!input.url || !/^https?:\/\//.test(input.url)) {
    return {
      error: {
        code: "missing_url",
        message: "url is required and must be http(s)",
        next_action: "Ask the user for the receiving URL (their Worker / Function endpoint).",
      },
    };
  }
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return { error: { code: "no_key", message: "No API key on file.", next_action: "Call `agentry_login` first." } };
  }
  const pid = pickProjectId(cfg, input.project_id);
  if (!pid) {
    return { error: { code: "no_project", message: "No project specified.", next_action: "Pass project_id." } };
  }
  const body: { url: string; events?: string[]; description?: string } = { url: input.url };
  if (input.events) body.events = input.events;
  if (input.description) body.description = input.description;
  const resp = await api.registerWebhook(cfg, pid, body);
  return {
    ...resp,
    project_id: pid,
    next_action:
      "STORE THE signing_secret NOW — it won't be shown again. " +
      "Tell the user to add it to their endpoint's env. Then call agentry_test_webhook to verify the wiring.",
  };
}

async function handleListWebhooks(projectId?: string): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return { error: { code: "no_key", message: "No API key.", next_action: "Call `agentry_login`." } };
  }
  const pid = pickProjectId(cfg, projectId);
  if (!pid) return { error: { code: "no_project", message: "No project specified.", next_action: "Pass project_id." } };
  const resp = await api.listWebhooks(cfg, pid);
  return { project_id: pid, ...resp };
}

async function handleListEventNames(projectId?: string): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return { error: { code: "no_key", message: "No API key.", next_action: "Call `agentry_login`." } };
  }
  const pid = pickProjectId(cfg, projectId);
  if (!pid) return { error: { code: "no_project", message: "No project specified.", next_action: "Pass project_id." } };
  const resp = await api.listEventNames(cfg, pid);
  return { project_id: pid, ...resp };
}

async function handleTestWebhook(input: { webhook_id: string; project_id?: string }): Promise<ToolResult> {
  if (!input.webhook_id) {
    return { error: { code: "missing_webhook_id", message: "webhook_id is required.", next_action: "Pass webhook id from agentry_list_webhooks." } };
  }
  const cfg = loadConfig();
  if (!cfg.api_key) return { error: { code: "no_key", message: "No API key.", next_action: "Call `agentry_login`." } };
  const pid = pickProjectId(cfg, input.project_id);
  if (!pid) return { error: { code: "no_project", message: "No project specified.", next_action: "Pass project_id." } };
  const resp = await api.testWebhook(cfg, pid, input.webhook_id);
  return {
    ...resp,
    project_id: pid,
    next_action:
      "Test fired. Call agentry_list_webhooks to see last_status — should be 200 if your endpoint accepted it.",
  };
}

async function handleDeleteWebhook(input: { webhook_id: string; project_id?: string }): Promise<ToolResult> {
  if (!input.webhook_id) {
    return { error: { code: "missing_webhook_id", message: "webhook_id is required.", next_action: "Pass webhook id." } };
  }
  const cfg = loadConfig();
  if (!cfg.api_key) return { error: { code: "no_key", message: "No API key.", next_action: "Call `agentry_login`." } };
  const pid = pickProjectId(cfg, input.project_id);
  if (!pid) return { error: { code: "no_project", message: "No project specified.", next_action: "Pass project_id." } };
  const resp = await api.deleteWebhook(cfg, pid, input.webhook_id);
  return { ...resp, project_id: pid };
}

async function handleAutomationDocs(): Promise<ToolResult> {
  const cfg = loadConfig();
  const md = await api.getAutomationDocs(cfg);
  return {
    docs_markdown: md,
    next_action:
      "Read the automation patterns. Each pattern includes a paste-ready Worker template the agent " +
      "can drop into the customer's repo. After deploying their endpoint, call agentry_register_webhook " +
      "with the URL, then agentry_test_webhook to confirm.",
  };
}

// ---------------------------------------------------------------------------
// Local memory file (agentry_memory.md)
// ---------------------------------------------------------------------------

function resolveLocalPath(cfg: AgentryConfig, projectId?: string): { id: string; localPath: string } | null {
  const id = projectId ?? cfg.default_project_id;
  if (!id) return null;
  const proj = cfg.projects[id];
  if (!proj || !proj.local_path) return null;
  return { id, localPath: proj.local_path };
}

async function handleRemember(input: {
  case_id: string;
  summary: string;
  fingerprint?: string;
  status?: string;
  error_type?: string;
  pr_url?: string;
  watch_for?: string;
  tags?: string[];
  project_id?: string;
}): Promise<ToolResult> {
  if (!input.case_id || !input.summary) {
    return {
      error: {
        code: "missing_input",
        message: "case_id and summary are required",
        next_action: "Pass both. Use agentry_get_case to find case_id; summary should describe what you learned.",
      },
    };
  }
  const cfg = loadConfig();
  const resolved = resolveLocalPath(cfg, input.project_id);
  if (!resolved) {
    return {
      error: {
        code: "no_local_path",
        message: "No local_path stored for this project — agentry_memory.md needs a local repo to write into.",
        next_action: "Recreate the project with `local_path` set (the absolute path to the repo on disk), then retry.",
      },
    };
  }
  const filePath = getMemoryPath(resolved.localPath);
  if (!filePath) {
    return { error: { code: "no_path", message: "Could not resolve memory file path.", next_action: "Check local_path." } };
  }
  const action = upsertCaseSection(filePath, {
    case_id: input.case_id,
    summary: input.summary,
    ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.error_type !== undefined ? { error_type: input.error_type } : {}),
    ...(input.pr_url !== undefined ? { pr_url: input.pr_url } : {}),
    ...(input.watch_for !== undefined ? { watch_for: input.watch_for } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
  });
  return {
    ok: true,
    file_path: filePath,
    action,
    next_action:
      "Memory updated. Future investigations can read this file directly (it's just markdown). " +
      "Consider committing agentry_memory.md so the team and future agents see prior context.",
  };
}

function handleRecall(input: { case_id?: string; project_id?: string }): ToolResult {
  const cfg = loadConfig();
  const resolved = resolveLocalPath(cfg, input.project_id);
  if (!resolved) {
    return {
      error: {
        code: "no_local_path",
        message: "No local_path stored for this project.",
        next_action: "Recreate the project with `local_path` set.",
      },
    };
  }
  const filePath = getMemoryPath(resolved.localPath)!;
  if (!fs.existsSync(filePath)) {
    return {
      file_path: filePath,
      content: null,
      next_action: `No ${MEMORY_FILENAME} yet. Call agentry_remember after your next investigation to start the memory file.`,
    };
  }
  if (input.case_id) {
    const section = readCaseSection(filePath, input.case_id);
    return {
      file_path: filePath,
      case_id: input.case_id,
      content: section,
      next_action: section
        ? "Read the section before investigating — prior knowledge is in there."
        : "No prior memory for this case_id. Investigate fresh and call agentry_remember when done.",
    };
  }
  const content = fs.readFileSync(filePath, "utf8");
  return {
    file_path: filePath,
    content,
    next_action:
      "Use this as context. For a specific case, pass case_id to filter. " +
      "You can also Read/Grep this file directly with the agent's file tools.",
  };
}

// ---------------------------------------------------------------------------
// Project health + alerts
// ---------------------------------------------------------------------------

async function handleProjectHealth(projectId?: string): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) return { error: { code: "no_key", message: "No API key.", next_action: "Call `agentry_login`." } };
  const pid = projectId ?? cfg.default_project_id;
  if (!pid) return { error: { code: "no_project", message: "No project specified.", next_action: "Pass project_id." } };
  const resp = await api.getProjectHealth(cfg, pid);
  return resp;
}

async function handleCreateAlert(input: {
  name: string;
  recipe_id: string;
  threshold_column: string;
  threshold_op: string;
  threshold_value: number;
  params: Record<string, unknown>;
  description?: string;
  webhook_id?: string;
  project_id?: string;
}): Promise<ToolResult> {
  if (!input.name || !input.recipe_id || !input.threshold_column || !input.threshold_op || !Number.isFinite(input.threshold_value)) {
    return {
      error: {
        code: "missing_input",
        message: "name, recipe_id, threshold_column, threshold_op, threshold_value are required",
        next_action: "Pass all five. Use agentry_list_recipes to find a recipe with the column you want to threshold.",
      },
    };
  }
  const cfg = loadConfig();
  if (!cfg.api_key) return { error: { code: "no_key", message: "No API key.", next_action: "Call `agentry_login`." } };
  const pid = input.project_id ?? cfg.default_project_id;
  if (!pid) return { error: { code: "no_project", message: "No project specified.", next_action: "Pass project_id." } };
  const body: Parameters<typeof api.createAlert>[2] = {
    name: input.name,
    recipe_id: input.recipe_id,
    threshold_column: input.threshold_column,
    threshold_op: input.threshold_op,
    threshold_value: input.threshold_value,
    params: input.params,
  };
  if (input.description) body.description = input.description;
  if (input.webhook_id) body.webhook_id = input.webhook_id;
  const resp = await api.createAlert(cfg, pid, body);
  return {
    ...resp,
    project_id: pid,
    next_action:
      "Alert stored. Tell the user to call agentry_evaluate_alert from their cron / GitHub Actions / Cloudflare Cron " +
      "(say every 5 minutes). When threshold crosses, agentry fires the linked webhook.",
  };
}

async function handleListAlerts(projectId?: string): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) return { error: { code: "no_key", message: "No API key.", next_action: "Call `agentry_login`." } };
  const pid = projectId ?? cfg.default_project_id;
  if (!pid) return { error: { code: "no_project", message: "No project specified.", next_action: "Pass project_id." } };
  const resp = await api.listAlerts(cfg, pid);
  return { project_id: pid, ...resp };
}

async function handleEvaluateAlert(input: { alert_id: string; project_id?: string }): Promise<ToolResult> {
  if (!input.alert_id) {
    return { error: { code: "missing_alert_id", message: "alert_id is required.", next_action: "Pass alert id from agentry_list_alerts." } };
  }
  const cfg = loadConfig();
  if (!cfg.api_key) return { error: { code: "no_key", message: "No API key.", next_action: "Call `agentry_login`." } };
  const pid = input.project_id ?? cfg.default_project_id;
  if (!pid) return { error: { code: "no_project", message: "No project specified.", next_action: "Pass project_id." } };
  const resp = await api.evaluateAlert(cfg, pid, input.alert_id);
  return { project_id: pid, ...resp };
}

async function handleDeleteAlert(input: { alert_id: string; project_id?: string }): Promise<ToolResult> {
  if (!input.alert_id) {
    return { error: { code: "missing_alert_id", message: "alert_id is required.", next_action: "Pass alert id." } };
  }
  const cfg = loadConfig();
  if (!cfg.api_key) return { error: { code: "no_key", message: "No API key.", next_action: "Call `agentry_login`." } };
  const pid = input.project_id ?? cfg.default_project_id;
  if (!pid) return { error: { code: "no_project", message: "No project specified.", next_action: "Pass project_id." } };
  const resp = await api.deleteAlert(cfg, pid, input.alert_id);
  return { ...resp, project_id: pid };
}

async function handleSendFeedback(input: {
  kind: "missing_feature" | "bug" | "ux_friction" | "other";
  message: string;
  agent_note?: string;
  tool_name?: string;
  attempt_count?: number;
  project_id?: string;
  claude_session_id?: string;
}): Promise<ToolResult> {
  if (!input.message?.trim()) {
    return {
      error: {
        code: "missing_message",
        message: "message is required.",
        next_action: "Pass the user's complaint verbatim, or a one-line summary of what they were trying to do.",
      },
    };
  }
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: {
        code: "no_key",
        message: "No API key — feedback is tied to a user, so login first.",
        next_action: "Call agentry_login.",
      },
    };
  }
  const body: Parameters<typeof api.sendFeedback>[1] = {
    kind: input.kind,
    message: input.message.trim(),
  };
  if (input.agent_note) body.agent_note = input.agent_note;
  if (input.tool_name) body.tool_name = input.tool_name;
  if (typeof input.attempt_count === "number") body.attempt_count = input.attempt_count;
  if (input.project_id) body.project_id = input.project_id;
  else if (cfg.default_project_id) body.project_id = cfg.default_project_id;
  if (input.claude_session_id) body.claude_session_id = input.claude_session_id;

  const resp = await api.sendFeedback(cfg, body);
  return {
    ok: true,
    feedback_id: resp.id,
    received_at: resp.received_at,
    next_action:
      resp.next_action ??
      "Feedback recorded. Tell the user one short line ('Logged that as feedback for the agentry team.') and move on.",
  };
}

async function handleListFeedback(input: {
  limit?: number;
  kind?: string;
  resolved?: boolean;
}): Promise<ToolResult> {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    return {
      error: { code: "no_key", message: "No API key.", next_action: "Call agentry_login." },
    };
  }
  const opts: Parameters<typeof api.listFeedback>[1] = {};
  if (typeof input.limit === "number") opts.limit = input.limit;
  if (input.kind) opts.kind = input.kind;
  if (typeof input.resolved === "boolean") opts.resolved = input.resolved;
  const resp = await api.listFeedback(cfg, opts);
  return resp;
}
