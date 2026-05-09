import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";

// Mock the db module so every getDb() call inside the app returns the
// in-memory drizzle instance keyed by the env's URL. The factory is hoisted,
// so we must import getDbForUrl from within it.
vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

// Import after the mock so the app picks up the stubbed getDb.
const { createApp } = await import("../src/index.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv();
  app = createApp();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function call(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(
    new Request(`http://test${path}`, {
      method: init?.method ?? "GET",
      headers,
      body,
    }),
    env,
  );
}

async function signup(email: string): Promise<{ apiKey: string; userId: string }> {
  const res = await call("/v1/auth/signup", {
    method: "POST",
    json: { email },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { api_key: string; user_id: string };
  return { apiKey: data.api_key, userId: data.user_id };
}

async function createProject(
  apiKey: string,
  name: string,
): Promise<{ id: string; dsn: string }> {
  const res = await call("/v1/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    json: { name },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { id: string; dsn: string };
  return data;
}

describe("discovery", () => {
  it("GET / returns metadata json", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { name: string; docs: string };
    expect(json.name).toBe("agentry");
    expect(json.docs).toBe("/llms.txt");
  });

  it("GET /llms.txt returns text/plain", async () => {
    const res = await call("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/plain");
    const txt = await res.text();
    expect(txt).toContain("agentry");
    expect(txt).toContain("MCP");
  });

  it("GET /v1/install/sdk/node returns code snippet", async () => {
    const res = await call("/v1/install/sdk/node");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { language: string; code: string; required_env: string[] };
    expect(json.language).toBe("node");
    expect(json.code).toContain("agentry.init");
    expect(json.required_env).toContain("AGENTRY_DSN");
  });

  it("unknown route returns 404 with code=not_found", async () => {
    const res = await call("/v1/does-not-exist");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("not_found");
  });
});

describe("auth", () => {
  it("signup mints a key and creates a user", async () => {
    const { apiKey, userId } = await signup("alice@example.com");
    expect(apiKey).toMatch(/^agk_/);
    expect(userId).toMatch(/-/);
  });

  it("signup twice for same email returns NEW key but SAME user", async () => {
    const a = await signup("bob@example.com");
    const b = await signup("bob@example.com");
    expect(a.userId).toBe(b.userId);
    expect(a.apiKey).not.toBe(b.apiKey);

    // Old key should still work (not revoked).
    const r1 = await call("/v1/projects", {
      headers: { authorization: `Bearer ${a.apiKey}` },
    });
    expect(r1.status).toBe(200);
  });

  it("signup with invalid email returns 400 invalid_payload", async () => {
    const res = await call("/v1/auth/signup", {
      method: "POST",
      json: { email: "not-an-email" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_payload");
  });

  it("signup with malformed JSON returns 400 invalid_payload", async () => {
    const res = await call("/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_payload");
  });

  it("signup is gated by ALLOW_UNVERIFIED_SIGNUP", async () => {
    env = await makeTestEnv({ allowSignup: false });
    const res = await call("/v1/auth/signup", {
      method: "POST",
      json: { email: "x@example.com" },
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("signup_disabled");
  });

  it("rotate revokes old key and issues new one", async () => {
    const { apiKey } = await signup("carol@example.com");
    const res = await call("/v1/auth/keys/rotate", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { api_key: string };
    expect(data.api_key).not.toBe(apiKey);

    // Old key should now fail.
    const oldRes = await call("/v1/projects", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(oldRes.status).toBe(401);

    // New key works.
    const newRes = await call("/v1/projects", {
      headers: { authorization: `Bearer ${data.api_key}` },
    });
    expect(newRes.status).toBe(200);
  });

  it("missing auth header returns 401 unauthorized", async () => {
    const res = await call("/v1/projects");
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("unauthorized");
  });

  it("invalid api key returns 401 invalid_api_key", async () => {
    const res = await call("/v1/projects", {
      headers: { authorization: "Bearer agk_nonsense" },
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_api_key");
  });
});

describe("projects", () => {
  it("creates a project and returns DSN + install_snippet", async () => {
    const { apiKey } = await signup("dan@example.com");
    const proj = await createProject(apiKey, "musicvideogen");
    expect(proj.id).toMatch(/-/);
    expect(proj.dsn).toMatch(/^agnt_/);
    expect(proj.dsn).toContain(proj.id);
  });

  it("lists projects without DSN", async () => {
    const { apiKey } = await signup("erin@example.com");
    await createProject(apiKey, "p1");
    await createProject(apiKey, "p2");
    const res = await call("/v1/projects", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await res.json()) as { projects: Array<{ name: string; dsn?: string }> };
    expect(data.projects).toHaveLength(2);
    for (const p of data.projects) {
      expect(p.dsn).toBeUndefined();
    }
  });

  it("rejects access to another user's project (tenancy)", async () => {
    const a = await signup("a@example.com");
    const b = await signup("b@example.com");
    const projA = await createProject(a.apiKey, "secret");
    const res = await call(`/v1/projects/${projA.id}`, {
      headers: { authorization: `Bearer ${b.apiKey}` },
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("forbidden");
  });

  it("returns 404 for unknown project id", async () => {
    const { apiKey } = await signup("frank@example.com");
    const res = await call("/v1/projects/00000000-0000-0000-0000-000000000000", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("ingest", () => {
  async function setup() {
    const { apiKey } = await signup("ing@example.com");
    const proj = await createProject(apiKey, "ing");
    return { apiKey, proj };
  }

  function basicEvent(): unknown {
    return {
      event_id: "abc123",
      platform: "node",
      release: "deadbeef",
      environment: "production",
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read property 'foo' of undefined",
            stacktrace: {
              frames: [
                {
                  filename: "/app/src/handler.ts",
                  function: "handleRequest",
                  lineno: 42,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
    };
  }

  it("accepts a Sentry-shape event with Bearer DSN, creates a case", async () => {
    const { apiKey, proj } = await setup();
    const ingestRes = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: basicEvent(),
    });
    expect(ingestRes.status).toBe(200);
    const ingestJson = (await ingestRes.json()) as {
      event_id: string;
      case_id: string;
      suppressed: boolean;
    };
    expect(ingestJson.suppressed).toBe(false);
    expect(ingestJson.case_id).toMatch(/-/);

    // Listing cases shows the new case
    const list = await call(`/v1/projects/${proj.id}/cases?status=open`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(list.status).toBe(200);
    const data = (await list.json()) as {
      cases: Array<{ id: string; error_type: string; event_count: number; last_deploy_sha: string | null }>;
    };
    expect(data.cases).toHaveLength(1);
    expect(data.cases[0]!.error_type).toBe("TypeError");
    expect(data.cases[0]!.event_count).toBe(1);
    expect(data.cases[0]!.last_deploy_sha).toBe("deadbeef");
  });

  it("accepts X-Sentry-Auth header", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: {
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${proj.dsn}`,
      },
      json: basicEvent(),
    });
    expect(res.status).toBe(200);
  });

  it("accepts ?sentry_key= query param", async () => {
    const { proj } = await setup();
    const res = await call(
      `/v1/store/${proj.id}/?sentry_key=${encodeURIComponent(proj.dsn)}`,
      { method: "POST", json: basicEvent() },
    );
    expect(res.status).toBe(200);
  });

  it("rejects mismatched DSN with 401 invalid_dsn", async () => {
    const { proj } = await setup();
    // Sign up a second user, mint a DSN, and try to use it for proj.
    const other = await signup("other@example.com");
    const otherProj = await createProject(other.apiKey, "other");
    const res = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherProj.dsn}` },
      json: basicEvent(),
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_dsn");
  });

  it("rejects missing DSN", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      json: basicEvent(),
    });
    expect(res.status).toBe(401);
  });

  it("increments event_count on second event with same fingerprint", async () => {
    const { apiKey, proj } = await setup();
    for (let i = 0; i < 3; i++) {
      const r = await call(`/v1/store/${proj.id}/`, {
        method: "POST",
        headers: { authorization: `Bearer ${proj.dsn}` },
        json: basicEvent(),
      });
      expect(r.status).toBe(200);
    }
    const list = await call(`/v1/projects/${proj.id}/cases`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as { cases: Array<{ event_count: number }> };
    expect(data.cases).toHaveLength(1);
    expect(data.cases[0]!.event_count).toBe(3);
  });

  it("handles malformed payload (no exception, no message) without 5xx", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { platform: "node" },
    });
    // We accept it (defensive): error_type defaults to "Error".
    expect(res.status).toBeLessThan(500);
  });

  it("handles huge stack without crashing", async () => {
    const { proj } = await setup();
    const frames = Array.from({ length: 500 }, (_, i) => ({
      filename: `/app/file${i}.ts`,
      function: `fn${i}`,
      lineno: i,
    }));
    const res = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        exception: {
          values: [
            { type: "RangeError", value: "stack overflow", stacktrace: { frames } },
          ],
        },
      },
    });
    expect(res.status).toBe(200);
  });

  it("handles 'throw \"string\"' shape (message only, no frames)", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { message: "something broke" },
    });
    expect(res.status).toBe(200);
  });

  it("malformed JSON body returns 400 invalid_payload", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proj.dsn}`,
        "content-type": "application/json",
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_payload");
  });
});

describe("cases", () => {
  async function seedCase() {
    const { apiKey } = await signup("case@example.com");
    const proj = await createProject(apiKey, "p");
    const res = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        release: "abc",
        exception: {
          values: [
            {
              type: "TypeError",
              value: "boom",
              stacktrace: {
                frames: [
                  { filename: "/app/x.ts", function: "f", lineno: 1, in_app: true },
                ],
              },
            },
          ],
        },
      },
    });
    const j = (await res.json()) as { case_id: string };
    return { apiKey, proj, caseId: j.case_id };
  }

  it("GET /v1/cases/:id returns CaseDetail with recent_events and next_actions", async () => {
    const { apiKey, caseId } = await seedCase();
    const res = await call(`/v1/cases/${caseId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      id: string;
      recent_events: unknown[];
      next_actions: string[];
      suppression_hints: unknown[];
    };
    expect(json.id).toBe(caseId);
    expect(json.recent_events.length).toBe(1);
    expect(Array.isArray(json.next_actions)).toBe(true);
    expect(json.next_actions.length).toBeGreaterThan(0);
    expect(Array.isArray(json.suppression_hints)).toBe(true);
  });

  it("PATCH /v1/cases/:id updates status and summary", async () => {
    const { apiKey, caseId } = await seedCase();
    const res = await call(`/v1/cases/${caseId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { status: "resolved", agent_summary: "fixed in PR #42" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; agent_summary: string };
    expect(json.status).toBe("resolved");
    expect(json.agent_summary).toBe("fixed in PR #42");
  });

  it("POST /v1/cases/:id/runs records an agent run", async () => {
    const { apiKey, caseId } = await seedCase();
    const res = await call(`/v1/cases/${caseId}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: {
        case_id: caseId,
        status: "pr_opened",
        summary_md: "Found null deref in handler.ts:42",
        pr_url: "https://github.com/x/y/pull/1",
      },
    });
    expect(res.status).toBe(200);
  });

  it("rejects access to another user's case (tenancy)", async () => {
    const { caseId } = await seedCase();
    const intruder = await signup("intruder@example.com");
    const res = await call(`/v1/cases/${caseId}`, {
      headers: { authorization: `Bearer ${intruder.apiKey}` },
    });
    expect(res.status).toBe(403);
  });

  it("filters cases by status, defaults to open", async () => {
    const { apiKey, proj, caseId } = await seedCase();
    // Mark resolved
    await call(`/v1/cases/${caseId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { status: "resolved" },
    });
    const open = await call(`/v1/projects/${proj.id}/cases`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const openJson = (await open.json()) as { cases: unknown[] };
    expect(openJson.cases).toHaveLength(0);

    const all = await call(`/v1/projects/${proj.id}/cases?status=all`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const allJson = (await all.json()) as { cases: unknown[] };
    expect(allJson.cases).toHaveLength(1);
  });
});

describe("suppressions", () => {
  it("auto_ignore returns 202 suppressed and creates no case", async () => {
    const { apiKey } = await signup("sup@example.com");
    const proj = await createProject(apiKey, "p");

    // Pre-fire one event to learn its fingerprint.
    const r1 = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        exception: {
          values: [
            {
              type: "NoiseError",
              value: "spam",
              stacktrace: {
                frames: [{ filename: "/app/n.ts", function: "noise", lineno: 1 }],
              },
            },
          ],
        },
      },
    });
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { case_id: string };

    // Get the fingerprint from the case detail.
    const detail = await call(`/v1/cases/${j1.case_id}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const detailJson = (await detail.json()) as { fingerprint: string };
    const fingerprint = detailJson.fingerprint;

    // Add an exact-match suppression.
    const supRes = await call(`/v1/projects/${proj.id}/suppressions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: {
        fingerprint_pattern: fingerprint,
        action: "auto_ignore",
        reason: "known noise",
      },
    });
    expect(supRes.status).toBe(200);

    // Next event with same fingerprint should be suppressed.
    const r2 = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        exception: {
          values: [
            {
              type: "NoiseError",
              value: "spam",
              stacktrace: {
                frames: [{ filename: "/app/n.ts", function: "noise", lineno: 1 }],
              },
            },
          ],
        },
      },
    });
    expect(r2.status).toBe(202);
    const j2 = (await r2.json()) as { suppressed: boolean };
    expect(j2.suppressed).toBe(true);
  });

  it("GET /v1/projects/:id/suppressions lists rules", async () => {
    const { apiKey } = await signup("ls@example.com");
    const proj = await createProject(apiKey, "p");
    await call(`/v1/projects/${proj.id}/suppressions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: {
        fingerprint_pattern: "abcdef",
        action: "prompt_hint",
        hint_text: "Look in handler.ts",
      },
    });
    const res = await call(`/v1/projects/${proj.id}/suppressions`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const json = (await res.json()) as { suppressions: unknown[] };
    expect(json.suppressions).toHaveLength(1);
  });

  it("rejects suppression access across users (tenancy)", async () => {
    const a = await signup("a2@example.com");
    const b = await signup("b2@example.com");
    const projA = await createProject(a.apiKey, "p");
    const res = await call(`/v1/projects/${projA.id}/suppressions`, {
      method: "POST",
      headers: { authorization: `Bearer ${b.apiKey}` },
      json: { fingerprint_pattern: "x", action: "auto_ignore" },
    });
    expect(res.status).toBe(403);
  });
});

describe("happy path: signup -> project -> ingest -> list -> get -> resolve", () => {
  it("walks the full lifecycle with agent-friendly responses at every step", async () => {
    const { apiKey } = await signup("happy@example.com");
    const proj = await createProject(apiKey, "happy-app");

    const ingest = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        release: "v1.2.3",
        exception: {
          values: [
            {
              type: "ReferenceError",
              value: "x is not defined",
              stacktrace: {
                frames: [
                  { filename: "/app/main.ts", function: "main", lineno: 7, in_app: true },
                ],
              },
            },
          ],
        },
      },
    });
    expect(ingest.status).toBe(200);
    const ingestJson = (await ingest.json()) as { case_id: string; next_action: string };
    expect(ingestJson.next_action).toContain("/v1/cases/");

    const list = await call(`/v1/projects/${proj.id}/cases`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as { cases: Array<{ id: string }>; next_action: string };
    expect(listJson.cases).toHaveLength(1);
    expect(listJson.next_action).toBeTruthy();

    const detail = await call(`/v1/cases/${ingestJson.case_id}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(detail.status).toBe(200);
    const detailJson = (await detail.json()) as {
      next_actions: string[];
      recent_events: unknown[];
    };
    expect(detailJson.next_actions.length).toBeGreaterThan(0);
    expect(detailJson.recent_events).toHaveLength(1);

    const resolve = await call(`/v1/cases/${ingestJson.case_id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}` },
      json: {
        status: "resolved",
        agent_summary: "Fixed by adding nullish guard.",
        pr_url: "https://github.com/x/y/pull/99",
      },
    });
    expect(resolve.status).toBe(200);
    const resolveJson = (await resolve.json()) as { status: string; next_action: string };
    expect(resolveJson.status).toBe("resolved");
    expect(resolveJson.next_action).toBeTruthy();
  });
});
