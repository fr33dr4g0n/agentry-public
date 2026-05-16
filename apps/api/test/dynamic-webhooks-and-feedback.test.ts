// Coverage for the dynamic event-name webhook system + the feedback endpoint.
//   - Wildcard matching (* and prefix.*)
//   - Analytics events fire webhooks subscribed to that event name
//   - All case state transitions fire their named webhook
//   - Feedback POST (auth, kind coerce, project ownership) + GET (filters)
//
// PostHog is mocked so analytics ingest reaches the webhook-firing path
// without actually talking to a real PostHog instance.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestEnv, type TestEnv } from "./setup.js";
import { matchesAny } from "../src/webhooks.js";

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

vi.mock("../src/posthog.js", async () => {
  const actual = await vi.importActual<typeof import("../src/posthog.js")>("../src/posthog.js");
  return {
    ...actual,
    isPosthogConfigured: () => true,
    forwardCapture: async () => ({ status: 200 }),
  };
});

const { createApp } = await import("../src/index.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;
const realFetch = globalThis.fetch;
let outboundCalls: Array<{ url: string; init: RequestInit }>;

beforeEach(async () => {
  env = await makeTestEnv({ withEncKey: true });
  app = createApp();
  outboundCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    outboundCalls.push({ url, init: init ?? {} });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
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
  const res = await call("/v1/auth/_test/login", { method: "POST", json: { email } });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { api_key: string; user_id: string };
  return { apiKey: data.api_key, userId: data.user_id };
}

async function createProject(apiKey: string, name: string): Promise<{ id: string; dsn: string }> {
  const res = await call("/v1/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    json: { name },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; dsn: string };
}

async function setup() {
  const { apiKey, userId } = await signup(`u-${Math.random()}@example.com`);
  const proj = await createProject(apiKey, "p");
  return { apiKey, userId, proj };
}

// Several test paths fire webhooks via waitUntil (fire-and-forget) — drain the
// async work by ticking a few times. Single setTimeout(0) is not enough when
// the same test triggers multiple webhooks back-to-back.
async function flushAsync() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// Wait until outboundCalls reaches `expected` or 200ms pass. Stable polling
// for tests that trigger multiple webhook deliveries in a row.
async function waitForCalls(predicate: (count: number) => boolean, timeoutMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(outboundCalls.length)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// matchesAny — pure unit
// ---------------------------------------------------------------------------

describe("matchesAny", () => {
  it("exact match", () => {
    expect(matchesAny(["case.created"], "case.created")).toBe(true);
    expect(matchesAny(["case.created"], "case.resolved")).toBe(false);
  });

  it("wildcard '*' matches anything", () => {
    expect(matchesAny(["*"], "case.created")).toBe(true);
    expect(matchesAny(["*"], "signup_completed")).toBe(true);
    expect(matchesAny(["*"], "")).toBe(true);
  });

  it("prefix wildcard 'foo.*' matches namespace", () => {
    expect(matchesAny(["case.*"], "case.created")).toBe(true);
    expect(matchesAny(["case.*"], "case.resolved")).toBe(true);
    expect(matchesAny(["case.*"], "deploy.recorded")).toBe(false);
  });

  it("mixed subscriptions match if any matches", () => {
    expect(matchesAny(["alert.*", "signup_completed"], "signup_completed")).toBe(true);
    expect(matchesAny(["alert.*", "signup_completed"], "alert.triggered")).toBe(true);
    expect(matchesAny(["alert.*", "signup_completed"], "purchase")).toBe(false);
  });

  it("no subscription matches → false", () => {
    expect(matchesAny([], "case.created")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Analytics → webhook firing
// ---------------------------------------------------------------------------

describe("analytics webhook firing", () => {
  it("fires a subscribed webhook when an analytics event with that name is ingested", async () => {
    const { apiKey, proj } = await setup();
    await call(`/v1/projects/${proj.id}/webhooks`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { url: "https://hooks.example.com/signup", events: ["signup_completed"] },
    });

    const res = await call(`/v1/analytics/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        event: "signup_completed",
        distinct_id: "u-123",
        properties: { plan: "pro" },
      },
    });
    expect(res.status).toBe(200);
    await waitForCalls((n) => outboundCalls.some((c) => c.url.includes("hooks.example.com")));

    // Only outbound call should be the webhook (PostHog is mocked).
    const hookCalls = outboundCalls.filter((c) => c.url.includes("hooks.example.com"));
    expect(hookCalls).toHaveLength(1);

    const body = JSON.parse(String(hookCalls[0]!.init.body)) as {
      event: string;
      data: { event: string; distinct_id: string; properties: Record<string, unknown> };
    };
    expect(body.event).toBe("signup_completed");
    expect(body.data.event).toBe("signup_completed");
    expect(body.data.distinct_id).toBe("u-123");
    expect(body.data.properties).toEqual({ plan: "pro" });

    const headers = new Headers(hookCalls[0]!.init.headers as HeadersInit);
    expect(headers.get("x-agentry-event")).toBe("signup_completed");
    expect(headers.get("x-agentry-signature")).toMatch(/t=\d+,v1=[0-9a-f]{64}/);
  });

  it("wildcard '*' fires on every analytics event, exact mismatch does not", async () => {
    const { apiKey, proj } = await setup();
    // Subscribe one webhook to everything, another to a specific event.
    await call(`/v1/projects/${proj.id}/webhooks`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { url: "https://hooks.example.com/everything", events: ["*"] },
    });
    await call(`/v1/projects/${proj.id}/webhooks`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { url: "https://hooks.example.com/purchase-only", events: ["purchase"] },
    });

    // Fire a non-matching event.
    await call(`/v1/analytics/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { event: "page_view" },
    });
    await waitForCalls(() => outboundCalls.some((c) => c.url.includes("everything")));
    await flushAsync();

    const after = outboundCalls.filter((c) => c.url.includes("hooks.example.com"));
    expect(after).toHaveLength(1);
    expect(after[0]!.url).toContain("everything");
  });

  it("does not fire any webhook if nobody is subscribed to the event name", async () => {
    const { apiKey, proj } = await setup();
    await call(`/v1/projects/${proj.id}/webhooks`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { url: "https://hooks.example.com/alerts", events: ["alert.*"] },
    });

    await call(`/v1/analytics/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { event: "page_view" },
    });
    await flushAsync();

    expect(outboundCalls.filter((c) => c.url.includes("hooks.example.com"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case state transitions → webhook firing
// ---------------------------------------------------------------------------

describe("case state transitions fire webhooks", () => {
  async function withCase(): Promise<{ apiKey: string; proj: { id: string; dsn: string }; caseId: string }> {
    const { apiKey, proj } = await setup();
    // Ingest one error so a case exists.
    const e = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { name: "TypeError", message: "x", stack: "at fn (a.ts:1)" },
    });
    expect(e.status).toBe(200);
    const body = (await e.json()) as { case_id: string };
    return { apiKey, proj, caseId: body.case_id };
  }

  async function setStatus(apiKey: string, caseId: string, status: string): Promise<void> {
    const res = await call(`/v1/cases/${caseId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { status },
    });
    expect(res.status).toBe(200);
    await flushAsync();
  }

  it("case.investigating, case.spurious, case.ignored each fire their named webhook", async () => {
    const { apiKey, proj, caseId } = await withCase();
    await call(`/v1/projects/${proj.id}/webhooks`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: {
        url: "https://hooks.example.com/case-all",
        events: ["case.investigating", "case.spurious", "case.ignored"],
      },
    });

    outboundCalls.length = 0;

    await setStatus(apiKey, caseId, "investigating");
    await setStatus(apiKey, caseId, "spurious");
    await setStatus(apiKey, caseId, "ignored");
    await waitForCalls((n) => n >= 3);

    const hooks = outboundCalls.filter((c) => c.url.includes("case-all"));
    expect(hooks).toHaveLength(3);
    const events = hooks.map(
      (c) => (JSON.parse(String(c.init.body)) as { event: string }).event,
    );
    expect(events).toEqual(["case.investigating", "case.spurious", "case.ignored"]);
  });

  it("transition resolved → !resolved fires case.reopened", async () => {
    const { apiKey, proj, caseId } = await withCase();
    await call(`/v1/projects/${proj.id}/webhooks`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: {
        url: "https://hooks.example.com/reopened",
        events: ["case.reopened"],
      },
    });

    await setStatus(apiKey, caseId, "resolved");
    outboundCalls.length = 0;
    await setStatus(apiKey, caseId, "open");
    await waitForCalls((n) => n >= 1);

    const hooks = outboundCalls.filter((c) => c.url.includes("reopened"));
    expect(hooks).toHaveLength(1);
    const body = JSON.parse(String(hooks[0]!.init.body)) as {
      event: string;
      data: { previous_status: string; status: string };
    };
    expect(body.event).toBe("case.reopened");
    expect(body.data.previous_status).toBe("resolved");
    expect(body.data.status).toBe("open");
  });

  it("'case.*' wildcard subscribes to every case transition", async () => {
    const { apiKey, proj, caseId } = await withCase();
    await call(`/v1/projects/${proj.id}/webhooks`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { url: "https://hooks.example.com/case-star", events: ["case.*"] },
    });

    outboundCalls.length = 0;
    await setStatus(apiKey, caseId, "investigating");
    await setStatus(apiKey, caseId, "resolved");
    await waitForCalls((n) => n >= 2);

    const hooks = outboundCalls.filter((c) => c.url.includes("case-star"));
    expect(hooks).toHaveLength(2);
    const events = hooks.map(
      (c) => (JSON.parse(String(c.init.body)) as { event: string }).event,
    );
    expect(events).toEqual(["case.investigating", "case.resolved"]);
  });
});

// ---------------------------------------------------------------------------
// Feedback endpoint
// ---------------------------------------------------------------------------

describe("feedback", () => {
  it("POST /v1/feedback requires auth", async () => {
    const res = await call("/v1/feedback", {
      method: "POST",
      json: { kind: "bug", message: "x" },
    });
    expect(res.status).toBe(401);
  });

  it("POST /v1/feedback persists with user attribution and coerces unknown kind", async () => {
    const { apiKey, userId, proj } = await setup();
    const res = await call("/v1/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: {
        kind: "definitely_not_a_real_kind",
        message: "wish I could query by tag",
        agent_note: "user tried agentry_run_recipe with no matching recipe",
        tool_name: "agentry_run_recipe",
        attempt_count: 3,
        project_id: proj.id,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; received_at: number; next_action: string };
    expect(body.id).toMatch(/-/);
    expect(body.received_at).toBeGreaterThan(0);

    // Now GET it back — verify userId is attached and kind was coerced to "other".
    const list = await call("/v1/feedback", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(list.status).toBe(200);
    const data = (await list.json()) as {
      count: number;
      feedback: Array<{
        id: string;
        user_id: string | null;
        project_id: string | null;
        kind: string;
        message: string;
        agent_note: string | null;
        tool_name: string | null;
        attempt_count: number | null;
      }>;
    };
    expect(data.count).toBe(1);
    const item = data.feedback[0]!;
    expect(item.user_id).toBe(userId);
    expect(item.project_id).toBe(proj.id);
    expect(item.kind).toBe("other");
    expect(item.message).toBe("wish I could query by tag");
    expect(item.agent_note).toContain("agentry_run_recipe");
    expect(item.tool_name).toBe("agentry_run_recipe");
    expect(item.attempt_count).toBe(3);
  });

  it("POST /v1/feedback rejects missing message", async () => {
    const { apiKey } = await setup();
    const res = await call("/v1/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { kind: "bug" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/feedback rejects project_id owned by another user (tenancy)", async () => {
    const a = await setup();
    const b = await signup("intruder@example.com");
    const res = await call("/v1/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${b.apiKey}` },
      json: { kind: "bug", message: "x", project_id: a.proj.id },
    });
    expect(res.status).toBe(403);
  });

  it("GET /v1/feedback filters by kind and resolved", async () => {
    const { apiKey } = await setup();
    for (const k of ["bug", "bug", "missing_feature"] as const) {
      await call("/v1/feedback", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        json: { kind: k, message: `${k}-msg` },
      });
    }

    const onlyBugs = await call("/v1/feedback?kind=bug", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const bugsData = (await onlyBugs.json()) as { count: number };
    expect(bugsData.count).toBe(2);

    const onlyMissing = await call("/v1/feedback?kind=missing_feature", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const missingData = (await onlyMissing.json()) as { count: number };
    expect(missingData.count).toBe(1);

    // Default resolved=0; explicit resolved=false also matches.
    const unresolved = await call("/v1/feedback?resolved=false", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const unresData = (await unresolved.json()) as { count: number };
    expect(unresData.count).toBe(3);

    const resolved = await call("/v1/feedback?resolved=true", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const resData = (await resolved.json()) as { count: number };
    expect(resData.count).toBe(0);
  });

  it("does not leak feedback from another user", async () => {
    const a = await setup();
    await call("/v1/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${a.apiKey}` },
      json: { kind: "bug", message: "mine" },
    });
    const b = await signup("other@example.com");
    const list = await call("/v1/feedback", {
      headers: { authorization: `Bearer ${b.apiKey}` },
    });
    const data = (await list.json()) as { count: number };
    expect(data.count).toBe(0);
  });
});
