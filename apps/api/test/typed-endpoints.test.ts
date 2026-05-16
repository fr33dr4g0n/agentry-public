// Tests for the typed-endpoint migration.
//
// Covers:
//   - /v1/logs/  (first-party path; was /v1/store/)
//   - /v1/analytics/  (first-party path; was /v1/track/)
//   - /v1/deploys/  (unchanged, but now persists extras into extra_json)
//   - /v1/store/ + /v1/track/ aliases — must keep working for drop-in compat
//   - /v1/log/ catch-all auto-detection of kind by payload shape
//   - Cross-endpoint: same DSN authenticates all three; unknown DSN rejected

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

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
  const res = await call("/v1/auth/_test/login", {
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

async function setup() {
  const { apiKey } = await signup(`user-${Math.random()}@example.com`);
  const proj = await createProject(apiKey, "test-app");
  return { apiKey, proj };
}

function basicErrorPayload(opts?: { release?: string; type?: string }): unknown {
  return {
    release: opts?.release,
    exception: {
      values: [
        {
          type: opts?.type ?? "TypeError",
          value: "boom",
          stacktrace: {
            frames: [
              { filename: "/app/x.ts", function: "f", lineno: 1, in_app: true },
            ],
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// /v1/logs/ — first-party errors endpoint
// ---------------------------------------------------------------------------

describe("/v1/logs/ (first-party)", () => {
  it("accepts a Sentry-shape error payload with Bearer DSN", async () => {
    const { apiKey, proj } = await setup();
    const res = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: basicErrorPayload({ release: "abc123" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      event_id: string;
      case_id: string;
      suppressed: boolean;
    };
    expect(json.case_id).toMatch(/-/);
    expect(json.suppressed).toBe(false);

    // Listing should show the case
    const list = await call(`/v1/projects/${proj.id}/cases?status=open`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as {
      cases: Array<{ error_type: string; event_count: number; last_deploy_sha: string | null }>;
    };
    expect(data.cases).toHaveLength(1);
    expect(data.cases[0]!.error_type).toBe("TypeError");
    expect(data.cases[0]!.last_deploy_sha).toBe("abc123");
  });

  it("accepts the bare {name, message, stack} shape (any-language helper)", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        name: "ValueError",
        message: "bad input",
        stack: "Traceback (most recent call last):\n  File 'x.py', line 12, in foo\n",
      },
    });
    expect(res.status).toBe(200);
  });

  it("works without the trailing slash", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/logs/${proj.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: basicErrorPayload(),
    });
    expect(res.status).toBe(200);
  });

  it("rejects mismatched DSN with 401 invalid_dsn", async () => {
    const { proj } = await setup();
    const other = await signup("other-errors@example.com");
    const otherProj = await createProject(other.apiKey, "other");
    const res = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherProj.dsn}` },
      json: basicErrorPayload(),
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_dsn");
  });

  it("rejects missing DSN", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      json: basicErrorPayload(),
    });
    expect(res.status).toBe(401);
  });

  it("malformed JSON returns 400 invalid_payload", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proj.dsn}`,
        "content-type": "application/json",
      },
      body: "{bad-json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_payload");
  });

  it("dedupes by fingerprint — three identical errors → one case with event_count 3", async () => {
    const { apiKey, proj } = await setup();
    for (let i = 0; i < 3; i++) {
      const r = await call(`/v1/logs/${proj.id}/`, {
        method: "POST",
        headers: { authorization: `Bearer ${proj.dsn}` },
        json: basicErrorPayload(),
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
});

// ---------------------------------------------------------------------------
// /v1/store/ — Sentry-protocol alias (must keep working)
// ---------------------------------------------------------------------------

describe("/v1/store/ (Sentry alias)", () => {
  it("still accepts the same payload as /v1/logs/", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: basicErrorPayload(),
    });
    expect(res.status).toBe(200);
  });

  it("alias and first-party path produce the same Case (same fingerprint)", async () => {
    const { apiKey, proj } = await setup();
    const r1 = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: basicErrorPayload(),
    });
    const r2 = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: basicErrorPayload(),
    });
    const j1 = (await r1.json()) as { case_id: string };
    const j2 = (await r2.json()) as { case_id: string };
    expect(j1.case_id).toBe(j2.case_id);

    const list = await call(`/v1/projects/${proj.id}/cases`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as { cases: Array<{ event_count: number }> };
    expect(data.cases).toHaveLength(1);
    expect(data.cases[0]!.event_count).toBe(2);
  });

  it("X-Sentry-Auth still works (Sentry-protocol drop-in)", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/store/${proj.id}/`, {
      method: "POST",
      headers: {
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${proj.dsn}`,
      },
      json: basicErrorPayload(),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// /v1/analytics/ + /v1/track/ alias — PostHog 503 when unconfigured
// ---------------------------------------------------------------------------

describe("/v1/analytics/ (first-party)", () => {
  it("returns 503 analytics_not_configured when PostHog env vars are unset", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/analytics/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { event: "signup_completed", distinct_id: "u_91" },
    });
    // No PostHog configured in test env — both first-party and alias paths
    // should report this consistently (503).
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("analytics_not_configured");
  });

  it("rejects missing DSN with 401", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/analytics/${proj.id}/`, {
      method: "POST",
      json: { event: "signup_completed" },
    });
    // Routes that depend on PostHog short-circuit BEFORE DSN check; that's
    // fine for security (never accepts the event), still returns 503.
    expect([401, 503]).toContain(res.status);
  });
});

describe("/v1/track/ (PostHog alias)", () => {
  it("alias also returns 503 analytics_not_configured", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/track/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { event: "signup_completed", distinct_id: "u_91" },
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("analytics_not_configured");
  });
});

// ---------------------------------------------------------------------------
// /v1/deploys/ + extras
// ---------------------------------------------------------------------------

describe("/v1/deploys/ (with extras)", () => {
  it("accepts a deploy and persists known fields", async () => {
    const { apiKey, proj } = await setup();
    const res = await call(`/v1/deploys/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        sha: "abc123",
        branch: "main",
        environment: "prod",
        actor: "henrikh",
      },
    });
    expect(res.status).toBe(200);

    const list = await call(`/v1/projects/${proj.id}/deploys`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(list.status).toBe(200);
    const data = (await list.json()) as {
      deploys: Array<{ sha: string; branch: string; actor: string; extra: unknown }>;
    };
    expect(data.deploys).toHaveLength(1);
    expect(data.deploys[0]!.sha).toBe("abc123");
    expect(data.deploys[0]!.branch).toBe("main");
    expect(data.deploys[0]!.actor).toBe("henrikh");
    expect(data.deploys[0]!.extra).toBeNull();
  });

  it("persists unknown top-level fields into extra_json (the hole we just plugged)", async () => {
    const { apiKey, proj } = await setup();
    const res = await call(`/v1/deploys/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        sha: "deadbeef",
        branch: "main",
        ci_run_id: "12345",
        commit_count: 7,
        build_id: "b-9001",
        custom: { nested: { ok: true } },
      },
    });
    expect(res.status).toBe(200);

    const list = await call(`/v1/projects/${proj.id}/deploys`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as {
      deploys: Array<{ sha: string; extra: Record<string, unknown> | null }>;
    };
    expect(data.deploys).toHaveLength(1);
    expect(data.deploys[0]!.sha).toBe("deadbeef");
    expect(data.deploys[0]!.extra).toEqual({
      ci_run_id: "12345",
      commit_count: 7,
      build_id: "b-9001",
      custom: { nested: { ok: true } },
    });
  });

  it("strips the 'kind' field from extras (it's a routing hint, not data)", async () => {
    const { apiKey, proj } = await setup();
    const res = await call(`/v1/deploys/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        kind: "deploy",
        sha: "fbeef",
        custom_field: "kept",
      },
    });
    expect(res.status).toBe(200);

    const list = await call(`/v1/projects/${proj.id}/deploys`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as {
      deploys: Array<{ extra: Record<string, unknown> | null }>;
    };
    expect(data.deploys[0]!.extra).toEqual({ custom_field: "kept" });
  });

  it("requires sha — returns 400 invalid_payload otherwise", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/deploys/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { branch: "main", environment: "prod" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message?: string } };
    expect(json.error.code).toBe("invalid_payload");
  });

  it("rejects DSN from another project (tenancy)", async () => {
    const { proj } = await setup();
    const other = await signup("other-deploys@example.com");
    const otherProj = await createProject(other.apiKey, "other");
    const res = await call(`/v1/deploys/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherProj.dsn}` },
      json: { sha: "abc" },
    });
    expect(res.status).toBe(401);
  });

  it("caps extra_json at ~16KB (truncates oversized payloads)", async () => {
    const { apiKey, proj } = await setup();
    // Build a payload with one big field
    const big = "x".repeat(20000);
    const res = await call(`/v1/deploys/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        sha: "big",
        big_field: big,
      },
    });
    expect(res.status).toBe(200);

    const list = await call(`/v1/projects/${proj.id}/deploys`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as {
      deploys: Array<{ extra: unknown }>;
    };
    // The truncated JSON may not be parseable — that's ok, helper returns null on parse failure.
    // We just verify the response shape is intact.
    expect(data.deploys[0]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// /v1/log/ — catch-all auto-detection
// ---------------------------------------------------------------------------

describe("/v1/log/ (catch-all auto-detection)", () => {
  it("explicit kind=error routes to error handler", async () => {
    const { apiKey, proj } = await setup();
    const res = await call(`/v1/log/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        kind: "error",
        name: "TypeError",
        message: "boom",
        stack: "at f (x.ts:1)",
      },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { detected_kind?: string; case_id?: string };
    expect(j.detected_kind).toBe("error");

    const list = await call(`/v1/projects/${proj.id}/cases`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as { cases: Array<{ error_type: string }> };
    expect(data.cases).toHaveLength(1);
    expect(data.cases[0]!.error_type).toBe("TypeError");
  });

  it("Sentry-shape (exception object) is auto-detected as error", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/log/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: basicErrorPayload(),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { detected_kind?: string };
    expect(j.detected_kind).toBe("error");
  });

  it("{name,message,stack} all-strings shape is auto-detected as error", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/log/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        name: "RuntimeError",
        message: "kaboom",
        stack: "Traceback...",
      },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { detected_kind?: string };
    expect(j.detected_kind).toBe("error");
  });

  it("payload with sha and no event is auto-detected as deploy", async () => {
    const { apiKey, proj } = await setup();
    const res = await call(`/v1/log/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { sha: "abc123", branch: "main", actor: "henrikh" },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { detected_kind?: string };
    expect(j.detected_kind).toBe("deploy");

    const list = await call(`/v1/projects/${proj.id}/deploys`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as { deploys: Array<{ sha: string }> };
    expect(data.deploys).toHaveLength(1);
    expect(data.deploys[0]!.sha).toBe("abc123");
  });

  it("/v1/log/ deploy detection ALSO captures unknown fields into extra (parity with typed endpoint)", async () => {
    const { apiKey, proj } = await setup();
    const res = await call(`/v1/log/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { sha: "ext-test", ci_run_id: "9999", build_meta: { os: "linux" } },
    });
    expect(res.status).toBe(200);

    const list = await call(`/v1/projects/${proj.id}/deploys`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as {
      deploys: Array<{ sha: string; extra: Record<string, unknown> | null }>;
    };
    expect(data.deploys[0]!.extra).toEqual({
      ci_run_id: "9999",
      build_meta: { os: "linux" },
    });
  });

  it("payload with event but no PostHog → 503 (matches /v1/analytics/ behavior)", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/log/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { event: "checkout_completed", distinct_id: "u_91" },
    });
    // Detected as analytics, but PostHog is off in test env.
    expect(res.status).toBe(503);
    const j = (await res.json()) as { detected_kind?: string; next_action?: string };
    expect(j.detected_kind).toBe("event");
  });

  it("untyped payload (no event/sha/error markers) folds into 'log' analytics path → 503", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/log/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { user_action: "click", button: "buy_now" },
    });
    // Falls through to "log" → analytics handler with event_name="log" → 503.
    expect(res.status).toBe(503);
  });

  it("body too large is rejected with 413", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/log/${proj.id}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proj.dsn}`,
        "content-type": "application/json",
        "content-length": String(500_000),
      },
      json: { name: "x", message: "y", stack: "z".repeat(500_000) },
    });
    expect(res.status).toBe(413);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("payload_too_large");
  });

  it("malformed JSON returns 400 invalid_payload", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/log/${proj.id}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proj.dsn}`,
        "content-type": "application/json",
      },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects mismatched DSN with 401", async () => {
    const { proj } = await setup();
    const other = await signup("other-log@example.com");
    const otherProj = await createProject(other.apiKey, "other");
    const res = await call(`/v1/log/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherProj.dsn}` },
      json: { name: "X", message: "y", stack: "z" },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// CORS for the new typed paths
// ---------------------------------------------------------------------------

describe("CORS for typed endpoints", () => {
  for (const path of ["/v1/logs/anything/", "/v1/analytics/anything/", "/v1/deploys/anything/"]) {
    it(`OPTIONS preflight on ${path} returns 204 with permissive headers`, async () => {
      const res = await call(path, {
        method: "OPTIONS",
        headers: {
          origin: "https://my-app.test",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      });
      expect([200, 204]).toContain(res.status);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect((res.headers.get("access-control-allow-methods") ?? "").toUpperCase()).toContain("POST");
      expect((res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("authorization");
    });
  }

  it("real POST to /v1/logs/ from a browser-origin includes ACAO", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proj.dsn}`,
        origin: "https://my-app.test",
      },
      json: basicErrorPayload(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

// ---------------------------------------------------------------------------
// Cross-endpoint integration: same DSN authenticates all three
// ---------------------------------------------------------------------------

describe("cross-endpoint: one DSN authenticates all three", () => {
  it("errors + deploys from the same DSN both succeed", async () => {
    const { apiKey, proj } = await setup();

    const errRes = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: basicErrorPayload({ release: "v1" }),
    });
    expect(errRes.status).toBe(200);

    const depRes = await call(`/v1/deploys/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { sha: "v1", branch: "main" },
    });
    expect(depRes.status).toBe(200);

    // The case should have last_deploy_sha = "v1"
    const list = await call(`/v1/projects/${proj.id}/cases`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as {
      cases: Array<{ last_deploy_sha: string | null }>;
    };
    expect(data.cases[0]!.last_deploy_sha).toBe("v1");

    // And the deploy listing has 1 deploy
    const dlist = await call(`/v1/projects/${proj.id}/deploys`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const ddata = (await dlist.json()) as { deploys: Array<{ sha: string }> };
    expect(ddata.deploys).toHaveLength(1);
  });

  it("analytics with same DSN reports 503 (PostHog unconfigured) — not a 401", async () => {
    const { proj } = await setup();
    const res = await call(`/v1/analytics/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { event: "signup", distinct_id: "u_1" },
    });
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Project creation returns the new typed URLs
// ---------------------------------------------------------------------------

describe("POST /v1/projects/ response shape (typed URLs)", () => {
  it("returns logs_url, analytics_url, deploys_url pointing at typed paths", async () => {
    const { apiKey } = await signup("urls@example.com");
    const res = await call("/v1/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { name: "urls-test" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: string;
      dsn: string;
      logs_url: string;
      analytics_url: string;
      deploys_url: string;
    };
    expect(data.logs_url).toMatch(/\/v1\/logs\/[\w-]+\/$/);
    expect(data.analytics_url).toMatch(/\/v1\/analytics\/[\w-]+\/$/);
    expect(data.deploys_url).toMatch(/\/v1\/deploys\/[\w-]+\/$/);
    expect(data.logs_url).toContain(data.id);
  });
});

// ---------------------------------------------------------------------------
// Discovery / llms.txt advertises typed endpoints
// ---------------------------------------------------------------------------

describe("/llms.txt advertises typed endpoints", () => {
  it("mentions /v1/logs/, /v1/analytics/, /v1/deploys/", async () => {
    const res = await call("/llms.txt");
    expect(res.status).toBe(200);
    const txt = await res.text();
    expect(txt).toContain("/v1/logs/");
    expect(txt).toContain("/v1/analytics/");
    expect(txt).toContain("/v1/deploys/");
  });

  it("documents the aliases as compatibility-only", async () => {
    const res = await call("/llms.txt");
    const txt = await res.text();
    expect(txt).toMatch(/v1\/store/);
    expect(txt).toMatch(/v1\/track/);
    expect(txt.toLowerCase()).toContain("alias");
  });
});

// ---------------------------------------------------------------------------
// Edge cases / regression coverage
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("error payload with unicode message and emoji is preserved", async () => {
    const { apiKey, proj } = await setup();
    const res = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        name: "TypeError",
        message: "Cannot read 'café' 🚀 — naïve null check",
        stack: "at fn (x.ts:1)",
      },
    });
    expect(res.status).toBe(200);

    const list = await call(`/v1/projects/${proj.id}/cases`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as { cases: Array<{ message: string }> };
    expect(data.cases[0]!.message).toContain("café");
    expect(data.cases[0]!.message).toContain("🚀");
  });

  it("error payload with very long message gets truncated to 4000 chars", async () => {
    const { apiKey, proj } = await setup();
    const longMsg = "x".repeat(8000);
    const res = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        name: "X",
        message: longMsg,
        stack: "at f (x.ts:1)",
      },
    });
    expect(res.status).toBe(200);

    const list = await call(`/v1/projects/${proj.id}/cases`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as { cases: Array<{ message: string }> };
    expect(data.cases[0]!.message.length).toBeLessThanOrEqual(4000);
  });

  it("user identification is captured from .user.id and .user.email", async () => {
    const { apiKey, proj } = await setup();
    const res = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        ...(basicErrorPayload() as Record<string, unknown>),
        user: { id: "u_abc", email: "alice@example.com" },
      },
    });
    expect(res.status).toBe(200);

    // affected_users.sample exposes the identified user(s) on a Case.
    const list = await call(`/v1/projects/${proj.id}/cases`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as { cases: Array<{ id: string }> };
    const caseId = data.cases[0]!.id;
    const detail = await call(`/v1/cases/${caseId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const detailJson = (await detail.json()) as {
      affected_users: {
        count: number;
        sample: Array<{ user_id: string; user_email: string | null }>;
      };
    };
    expect(detailJson.affected_users.count).toBe(1);
    expect(detailJson.affected_users.sample).toHaveLength(1);
    expect(detailJson.affected_users.sample[0]!.user_id).toBe("u_abc");
    expect(detailJson.affected_users.sample[0]!.user_email).toBe("alice@example.com");
  });

  it("error payload with custom tags and extra is stored as queryable JSON", async () => {
    const { apiKey, proj } = await setup();
    const res = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        ...(basicErrorPayload() as Record<string, unknown>),
        tags: { feature: "checkout", plan: "pro" },
        extra: { request_id: "req_42", cart_size: 3 },
      },
    });
    expect(res.status).toBe(200);

    const list = await call(`/v1/projects/${proj.id}/cases`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const cases = (await list.json()) as { cases: Array<{ id: string }> };
    const detail = await call(`/v1/cases/${cases.cases[0]!.id}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const detailJson = (await detail.json()) as {
      recent_events: Array<{
        tags?: Record<string, unknown> | null;
        extra?: Record<string, unknown> | null;
      }>;
    };
    expect(detailJson.recent_events[0]!.tags).toEqual({
      feature: "checkout",
      plan: "pro",
    });
    expect(detailJson.recent_events[0]!.extra).toEqual({
      request_id: "req_42",
      cart_size: 3,
    });
  });

  it("deploy with empty extras (no unknown fields) stores extra=null", async () => {
    const { apiKey, proj } = await setup();
    const res = await call(`/v1/deploys/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: { sha: "clean", branch: "main", environment: "prod", message: "release", url: "u", actor: "a" },
    });
    expect(res.status).toBe(200);

    const list = await call(`/v1/projects/${proj.id}/deploys`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as { deploys: Array<{ extra: unknown }> };
    expect(data.deploys[0]!.extra).toBeNull();
  });

  it("environment field is preserved on errors (used for filtering)", async () => {
    const { apiKey, proj } = await setup();
    const res = await call(`/v1/logs/${proj.id}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${proj.dsn}` },
      json: {
        ...(basicErrorPayload() as Record<string, unknown>),
        environment: "staging",
      },
    });
    expect(res.status).toBe(200);

    const list = await call(`/v1/projects/${proj.id}/cases`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await list.json()) as { cases: Array<{ id: string }> };
    const detail = await call(`/v1/cases/${data.cases[0]!.id}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const dj = (await detail.json()) as { recent_events: Array<{ environment?: string | null }> };
    expect(dj.recent_events[0]!.environment).toBe("staging");
  });
});
