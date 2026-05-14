// Unit tests for the MCP tool dispatcher. fetch is fully mocked.
// AGENTRY_CONFIG_PATH is set to a tmp file so we never touch the real ~/.agentry.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpConfigPath: string;

// Each test sets up its own fetch mock with a queue of responses.
type FetchMock = ReturnType<typeof vi.fn>;

function setFetchResponses(
  mock: FetchMock,
  responses: Array<{
    status?: number;
    body: unknown;
    assertUrl?: (url: string) => void;
    assertInit?: (init: RequestInit) => void;
  }>
) {
  let i = 0;
  mock.mockImplementation(async (url: string, init: RequestInit) => {
    const resp = responses[i++];
    if (!resp) throw new Error(`fetch called more than expected (i=${i}): ${url}`);
    resp.assertUrl?.(url);
    resp.assertInit?.(init);
    const status = resp.status ?? 200;
    const text = typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as unknown as Response;
  });
}

beforeEach(() => {
  tmpConfigPath = path.join(
    os.tmpdir(),
    `agentry-mcp-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`
  );
  process.env.AGENTRY_CONFIG_PATH = tmpConfigPath;
  process.env.AGENTRY_SERVER_URL = "https://test.example.com";
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  try {
    fs.unlinkSync(tmpConfigPath);
  } catch {
    // ignore
  }
  delete process.env.AGENTRY_CONFIG_PATH;
  delete process.env.AGENTRY_SERVER_URL;
  vi.restoreAllMocks();
});

describe("agentry_status", () => {
  it("reports no_key when nothing is set up", async () => {
    const { dispatchTool } = await import("./tools.js");
    const result = await dispatchTool("agentry_status", {});
    expect(result).toMatchObject({
      has_api_key: false,
      project_count: 0,
      onboarding: { state: "no_key", next_tool: "agentry_login" },
    });
    expect(JSON.stringify(result)).toContain("agentry_login");
  });
});

describe("agentry_login", () => {
  it("start_only returns verification_uri + user_code + device_code without polling", async () => {
    const fetchMock = globalThis.fetch as unknown as FetchMock;
    setFetchResponses(fetchMock, [
      {
        body: {
          device_code: "dev_abc",
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        },
        assertUrl: (url) =>
          expect(url).toBe("https://test.example.com/v1/auth/device"),
      },
    ]);

    const { dispatchTool } = await import("./tools.js");
    const result = (await dispatchTool("agentry_login", { mode: "start_only" })) as {
      verification_uri: string;
      user_code: string;
      device_code: string;
    };
    expect(result.user_code).toBe("WDJB-MJHT");
    expect(result.verification_uri).toBe("https://github.com/login/device");
    expect(result.device_code).toBe("dev_abc");
  });

  it("poll_once returns pending when GitHub still pending", async () => {
    const fetchMock = globalThis.fetch as unknown as FetchMock;
    setFetchResponses(fetchMock, [
      {
        body: { status: "pending", next_action: "Wait and retry." },
        assertUrl: (url) =>
          expect(url).toBe("https://test.example.com/v1/auth/device/poll"),
        assertInit: (init) =>
          expect(JSON.parse(init.body as string)).toEqual({ device_code: "dev_abc" }),
      },
    ]);
    const { dispatchTool } = await import("./tools.js");
    const result = (await dispatchTool("agentry_login", {
      mode: "poll_once",
      device_code: "dev_abc",
    })) as { ok: boolean; status: string };
    expect(result.ok).toBe(false);
    expect(result.status).toBe("pending");
  });

  it("poll_once persists api_key on success", async () => {
    const fetchMock = globalThis.fetch as unknown as FetchMock;
    setFetchResponses(fetchMock, [
      {
        body: {
          status: "ok",
          api_key: "agk_test_secret",
          user_id: "usr_1",
          prefix: "agk_test_",
          github: { id: 42, username: "alice", email: "a@b.com", avatar_url: null },
          next_action: "Now call POST /v1/projects.",
        },
      },
    ]);
    const { dispatchTool } = await import("./tools.js");
    const result = (await dispatchTool("agentry_login", {
      mode: "poll_once",
      device_code: "dev_abc",
    })) as { ok: boolean; user_id: string };
    expect(result.ok).toBe(true);
    expect(result.user_id).toBe("usr_1");
    const persisted = JSON.parse(fs.readFileSync(tmpConfigPath, "utf8"));
    expect(persisted.api_key).toBe("agk_test_secret");
  });

  it("poll_once without device_code returns an error", async () => {
    const { dispatchTool } = await import("./tools.js");
    const result = (await dispatchTool("agentry_login", { mode: "poll_once" })) as {
      error: { code: string };
    };
    expect(result.error.code).toBe("missing_device_code");
  });
});

describe("agentry_list_projects", () => {
  it("parses response and enriches with local_path", async () => {
    fs.mkdirSync(path.dirname(tmpConfigPath), { recursive: true });
    fs.writeFileSync(
      tmpConfigPath,
      JSON.stringify({
        server_url: "https://test.example.com",
        api_key: "agk_existing",
        default_project_id: "p1",
        projects: {
          p1: {
            id: "p1",
            name: "musicvideogen",
            dsn: "agnt_p1.tokenAbc",
            local_path: "/Users/me/code/musicvideogen",
            default_branch: "main",
          },
        },
      })
    );

    const fetchMock = globalThis.fetch as unknown as FetchMock;
    setFetchResponses(fetchMock, [
      {
        body: {
          projects: [
            {
              id: "p1",
              name: "musicvideogen",
              repo_url: null,
              default_branch: "main",
              created_at: 1715000000,
            },
            {
              id: "p2",
              name: "other",
              repo_url: null,
              default_branch: "main",
              created_at: 1715000010,
            },
          ],
        },
        assertInit: (init) => {
          const headers = init.headers as Record<string, string>;
          expect(headers["authorization"]).toBe("Bearer agk_existing");
        },
      },
    ]);

    const { dispatchTool } = await import("./tools.js");
    const result = (await dispatchTool("agentry_list_projects", {})) as {
      projects: Array<{ id: string; local_path: string | null; is_default: boolean }>;
      default_project_id: string;
    };
    expect(result.default_project_id).toBe("p1");
    expect(result.projects).toHaveLength(2);
    expect(result.projects[0]).toMatchObject({
      id: "p1",
      local_path: "/Users/me/code/musicvideogen",
      is_default: true,
    });
    expect(result.projects[1]).toMatchObject({
      id: "p2",
      local_path: null,
      is_default: false,
    });
  });
});

describe("agentry_get_case", () => {
  it("enriches with local_path from the project lookup", async () => {
    fs.mkdirSync(path.dirname(tmpConfigPath), { recursive: true });
    fs.writeFileSync(
      tmpConfigPath,
      JSON.stringify({
        server_url: "https://test.example.com",
        api_key: "agk_existing",
        default_project_id: "p1",
        projects: {
          p1: {
            id: "p1",
            name: "musicvideogen",
            dsn: "agnt_p1.tokenAbc",
            local_path: "/Users/me/code/musicvideogen",
            default_branch: "main",
          },
        },
      })
    );

    const fetchMock = globalThis.fetch as unknown as FetchMock;
    setFetchResponses(fetchMock, [
      {
        body: {
          id: "case_1",
          project_id: "p1",
          fingerprint: "abc",
          error_type: "TypeError",
          message: "x is undefined",
          status: "open",
          event_count: 3,
          first_seen_at: 1715000000,
          last_seen_at: 1715000300,
          last_deploy_sha: null,
          agent_summary: null,
          pr_url: null,
          recent_events: [],
          suppression_hints: [],
          local_path: null,
          next_actions: ["cd into local_path", "read the stack frame zero file"],
        },
      },
    ]);

    const { dispatchTool } = await import("./tools.js");
    const result = (await dispatchTool("agentry_get_case", { case_id: "case_1" })) as {
      local_path: string | null;
      next_action: string;
    };
    expect(result.local_path).toBe("/Users/me/code/musicvideogen");
    expect(result.next_action).toContain("cd");
  });
});

describe("error propagation", () => {
  it("propagates next_action verbatim from the API error", async () => {
    fs.mkdirSync(path.dirname(tmpConfigPath), { recursive: true });
    fs.writeFileSync(
      tmpConfigPath,
      JSON.stringify({
        server_url: "https://test.example.com",
        api_key: "agk_bad",
        default_project_id: null,
        projects: {},
      })
    );

    const fetchMock = globalThis.fetch as unknown as FetchMock;
    setFetchResponses(fetchMock, [
      {
        status: 401,
        body: {
          error: {
            code: "invalid_api_key",
            message: "API key not recognized or revoked.",
            next_action: "Call agentry_login to authenticate via GitHub and mint a fresh key.",
          },
        },
      },
    ]);

    const { dispatchTool } = await import("./tools.js");
    const result = (await dispatchTool("agentry_list_projects", {})) as {
      error: { code: string; message: string; next_action: string };
    };
    expect(result.error.code).toBe("invalid_api_key");
    expect(result.error.next_action).toContain("agentry_login");
  });
});

describe("agentry_capture_test_event", () => {
  it("uses the locally stored DSN to hit /v1/logs/:id/ (first-party path)", async () => {
    fs.mkdirSync(path.dirname(tmpConfigPath), { recursive: true });
    fs.writeFileSync(
      tmpConfigPath,
      JSON.stringify({
        server_url: "https://test.example.com",
        api_key: "agk_existing",
        default_project_id: "proj_xyz",
        projects: {
          proj_xyz: {
            id: "proj_xyz",
            name: "musicvideogen",
            dsn: "agnt_proj_xyz.publickey123",
            local_path: "/tmp/repo",
            default_branch: "main",
          },
        },
      })
    );

    const fetchMock = globalThis.fetch as unknown as FetchMock;
    setFetchResponses(fetchMock, [
      {
        body: { id: "evt_1", case_id: "case_99" },
        assertUrl: (url) => {
          expect(url).toBe("https://test.example.com/v1/logs/proj_xyz/");
        },
        assertInit: (init) => {
          const headers = init.headers as Record<string, string>;
          expect(headers["x-sentry-auth"]).toContain("sentry_key=agnt_proj_xyz.publickey123");
          // ingest must NOT send Authorization bearer
          expect(headers["authorization"]).toBeUndefined();
          const body = JSON.parse(init.body as string);
          expect(body.platform).toBe("node");
          expect(body.exception.values[0].type).toBe("AgentryTestError");
        },
      },
    ]);

    const { dispatchTool } = await import("./tools.js");
    const result = (await dispatchTool("agentry_capture_test_event", {})) as {
      ok: boolean;
      event_id: string;
      case_id: string | null;
      next_action: string;
    };
    expect(result.ok).toBe(true);
    expect(result.event_id).toBe("evt_1");
    expect(result.case_id).toBe("case_99");
    expect(result.next_action).toContain("case_99");
  });

  it("returns helpful error when no project is stored locally", async () => {
    fs.mkdirSync(path.dirname(tmpConfigPath), { recursive: true });
    fs.writeFileSync(
      tmpConfigPath,
      JSON.stringify({
        server_url: "https://test.example.com",
        api_key: "agk_existing",
        default_project_id: null,
        projects: {},
      })
    );

    const { dispatchTool } = await import("./tools.js");
    const result = (await dispatchTool("agentry_capture_test_event", {})) as {
      error: { code: string; next_action: string };
    };
    expect(result.error.code).toBe("no_project");
    expect(result.error.next_action).toContain("agentry_create_project");
  });
});

describe("tool list completeness", () => {
  it("registers the v0 tool set", async () => {
    const { TOOL_DESCRIPTORS } = await import("./tools.js");
    const names = TOOL_DESCRIPTORS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "agentry_analytics_query",
        "agentry_automation_docs",
        "agentry_capture_test_event",
        "agentry_create_alert",
        "agentry_create_project",
        "agentry_delete_alert",
        "agentry_delete_webhook",
        "agentry_evaluate_alert",
        "agentry_get_case",
        "agentry_install_guide",
        "agentry_install_sdk",
        "agentry_list_alerts",
        "agentry_list_cases",
        "agentry_list_deploys",
        "agentry_list_event_names",
        "agentry_list_feedback",
        "agentry_list_projects",
        "agentry_list_recipes",
        "agentry_list_webhooks",
        "agentry_login",
        "agentry_mark_spurious",
        "agentry_project_health",
        "agentry_query_docs",
        "agentry_recall",
        "agentry_record_deploy",
        "agentry_record_suppression",
        "agentry_register_webhook",
        "agentry_remember",
        "agentry_resolve_case",
        "agentry_rotate_key",
        "agentry_run_recipe",
        "agentry_send_feedback",
        "agentry_status",
        "agentry_suggested_next_steps",
        "agentry_test_webhook",
        "agentry_track_test_event",
        "agentry_unmangle_stack",
        "agentry_verify_install",
      ].sort()
    );
  });
});
