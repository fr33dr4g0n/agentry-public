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
      onboarding: { state: "no_key", next_tool: "agentry_signup" },
    });
    // The next_steps array must literally tell the agent what to call.
    expect(JSON.stringify(result)).toContain("agentry_signup");
  });
});

describe("agentry_signup", () => {
  it("persists the api_key to local config", async () => {
    const fetchMock = globalThis.fetch as unknown as FetchMock;
    setFetchResponses(fetchMock, [
      {
        body: {
          api_key: "agk_test_secret",
          user_id: "usr_1",
          prefix: "agk_test_",
          next_action: "Stored. Now call POST /v1/projects.",
        },
        assertUrl: (url) => expect(url).toBe("https://test.example.com/v1/auth/signup"),
        assertInit: (init) => {
          expect(init.method).toBe("POST");
          expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.com" });
          // Signup should not send Authorization
          const headers = init.headers as Record<string, string>;
          expect(headers["authorization"]).toBeUndefined();
        },
      },
    ]);

    const { dispatchTool } = await import("./tools.js");
    const result = await dispatchTool("agentry_signup", { email: "a@b.com" });
    expect(result).toMatchObject({
      ok: true,
      api_key_prefix: "agk_test_",
      user_id: "usr_1",
    });
    const persisted = JSON.parse(fs.readFileSync(tmpConfigPath, "utf8"));
    expect(persisted.api_key).toBe("agk_test_secret");
  });

  it("returns missing_email when email omitted", async () => {
    const { dispatchTool } = await import("./tools.js");
    const result = (await dispatchTool("agentry_signup", {})) as { error: { code: string } };
    expect(result.error.code).toBe("missing_email");
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
            dsn: "https://abc@test.example.com/p1",
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
            dsn: "https://abc@test.example.com/p1",
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
            next_action: "Call POST /v1/auth/signup with the user's email to mint a fresh key.",
          },
        },
      },
    ]);

    const { dispatchTool } = await import("./tools.js");
    const result = (await dispatchTool("agentry_list_projects", {})) as {
      error: { code: string; message: string; next_action: string };
    };
    expect(result.error.code).toBe("invalid_api_key");
    expect(result.error.next_action).toContain("/v1/auth/signup");
  });
});

describe("agentry_capture_test_event", () => {
  it("uses the locally stored DSN to hit /v1/store/:id/", async () => {
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
            dsn: "https://publickey123@test.example.com/proj_xyz",
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
          expect(url).toBe("https://test.example.com/v1/store/proj_xyz/");
        },
        assertInit: (init) => {
          const headers = init.headers as Record<string, string>;
          expect(headers["x-sentry-auth"]).toContain("sentry_key=publickey123");
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
  it("registers all 13 tools", async () => {
    const { TOOL_DESCRIPTORS } = await import("./tools.js");
    const names = TOOL_DESCRIPTORS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "agentry_capture_test_event",
        "agentry_create_project",
        "agentry_get_case",
        "agentry_install_sdk",
        "agentry_list_cases",
        "agentry_list_projects",
        "agentry_mark_spurious",
        "agentry_record_suppression",
        "agentry_recover",
        "agentry_resolve_case",
        "agentry_rotate_key",
        "agentry_signup",
        "agentry_status",
      ].sort()
    );
  });
});
