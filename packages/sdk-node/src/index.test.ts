import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentryClient } from "./client.js";
import { buildEventPayload } from "./payload.js";
import { parseStack } from "./stack.js";

// Realistic-shaped DSN; matches `agnt_<projectId>.<token>` format from @agentry/shared.
const DSN = "agnt_proj-abc-123.tok_secrettoken_456";
const PROJECT_ID = "proj-abc-123";
const SERVER_URL = "https://ingest.test";

function mockFetchOk() {
  const fn = vi.fn(async () => new Response(null, { status: 204 }));
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

function mockFetchStatus(status: number) {
  const fn = vi.fn(async () => new Response(null, { status }));
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentryClient.init / capture / flush", () => {
  it("captures an Error and POSTs the right payload on flush", async () => {
    const fetchMock = mockFetchOk();
    const c = new AgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL, environment: "test", deploySha: "abc123" });

    c.capture(new Error("kaboom"));
    const ok = await c.flush();
    expect(ok).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${SERVER_URL}/v1/store/${PROJECT_ID}/`);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${DSN}`);
    expect(headers["content-type"]).toBe("application/json");

    const event = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(event["platform"]).toBe("node");
    expect(event["environment"]).toBe("test");
    expect(event["deploy_sha"]).toBe("abc123");
    expect(event["release"]).toBe("abc123");
    expect(event["event_id"]).toMatch(/^[0-9a-f]{32}$/);
    const exception = event["exception"] as { values: Array<{ type: string; value: string }> };
    expect(exception.values[0]!.type).toBe("Error");
    expect(exception.values[0]!.value).toBe("kaboom");

    await c.close();
  });

  it("uses an explicit release over deploySha", async () => {
    const fetchMock = mockFetchOk();
    const c = new AgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL, deploySha: "abc", release: "v1.2.3" });
    c.capture(new Error("x"));
    await c.flush();
    const event = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as Record<string, unknown>;
    expect(event["release"]).toBe("v1.2.3");
    expect(event["deploy_sha"]).toBe("abc");
    await c.close();
  });

  it("capture before init is a no-op and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = mockFetchOk();
    const c = new AgentryClient();

    c.capture(new Error("ignored"));
    c.capture(new Error("ignored2"));
    expect(c._getQueueLength()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed dsn and disables capture", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = new AgentryClient();
    c.init({ dsn: "not-a-real-dsn" });
    expect(c._isInitialized()).toBe(false);
    c.capture(new Error("x"));
    expect(c._getQueueLength()).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("captures various non-Error throws without crashing", async () => {
    const fetchMock = mockFetchOk();
    const c = new AgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });

    c.capture(null);
    c.capture(undefined);
    c.capture("plain string");
    c.capture({ custom: true, message: "object message" });
    c.capture(new TypeError("typed"));
    c.capture(42);

    await c.flush();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const events = fetchMock.mock.calls.map((call) => {
      return JSON.parse((call[1] as RequestInit).body as string) as {
        exception: { values: Array<{ type: string; value: string }> };
      };
    });
    expect(events[0]!.exception.values[0]!.value).toBe("null");
    expect(events[1]!.exception.values[0]!.value).toBe("undefined");
    expect(events[2]!.exception.values[0]!.value).toBe("plain string");
    expect(events[3]!.exception.values[0]!.value).toBe("object message");
    expect(events[4]!.exception.values[0]!.type).toBe("TypeError");
    expect(events[4]!.exception.values[0]!.value).toBe("typed");
    expect(events[5]!.exception.values[0]!.value).toBe("42");
    await c.close();
  });

  it("captures subclass with custom name", async () => {
    const fetchMock = mockFetchOk();
    const c = new AgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });
    class MyDomainError extends Error {
      override name = "MyDomainError";
    }
    c.capture(new MyDomainError("nope"));
    await c.flush();
    const event = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as {
      exception: { values: Array<{ type: string }> };
    };
    expect(event.exception.values[0]!.type).toBe("MyDomainError");
    await c.close();
  });

  it("flush(timeoutMs) returns false when fetch hangs past the timeout", async () => {
    let abortReceived: Error | null = null;
    globalThis.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          abortReceived = err;
          reject(err);
        });
      });
    }) as unknown as typeof globalThis.fetch;

    const c = new AgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });
    c.capture(new Error("hang"));
    const ok = await c.flush(50);
    expect(ok).toBe(false);
    expect(abortReceived).not.toBeNull();
    // Event should have been requeued.
    expect(c._getQueueLength()).toBe(1);
    // Restore a benign fetch so close() doesn't hang on the previous mock.
    mockFetchOk();
    await c.close();
  });

  it("retains events on 5xx, drops on 4xx (other than 429)", async () => {
    const c = new AgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });

    mockFetchStatus(500);
    c.capture(new Error("a"));
    let ok = await c.flush();
    expect(ok).toBe(false);
    expect(c._getQueueLength()).toBe(1);

    mockFetchStatus(429);
    ok = await c.flush();
    expect(ok).toBe(false);
    expect(c._getQueueLength()).toBe(1);

    mockFetchStatus(400);
    ok = await c.flush();
    expect(ok).toBe(true);
    expect(c._getQueueLength()).toBe(0);

    // After the drop, a fresh capture + flush works.
    mockFetchOk();
    c.capture(new Error("b"));
    ok = await c.flush();
    expect(ok).toBe(true);
    expect(c._getQueueLength()).toBe(0);
    await c.close();
  });

  it("caps the buffer at 1000 events after 5xx", async () => {
    mockFetchStatus(500);
    const c = new AgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL, flushIntervalMs: 0 });

    for (let i = 0; i < 2000; i++) c.capture(new Error(`e${i}`));
    // capture itself should already cap at 1000
    expect(c._getQueueLength()).toBeLessThanOrEqual(1000);

    const ok = await c.flush();
    expect(ok).toBe(false);
    expect(c._getQueueLength()).toBeLessThanOrEqual(1000);
    await c.close();
  });

  it("flushes on simulated beforeExit", async () => {
    const fetchMock = mockFetchOk();
    const c = new AgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });
    c.capture(new Error("exit"));
    expect(c._getQueueLength()).toBe(1);

    // Trigger the registered beforeExit listener directly.
    process.emit("beforeExit", 0);
    // give the microtask queue a few cycles to drain
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await c.close();
  });

  it("close() flushes and detaches", async () => {
    const fetchMock = mockFetchOk();
    const c = new AgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });
    c.capture(new Error("bye"));
    await c.close();
    expect(fetchMock).toHaveBeenCalled();
    expect(c._getQueueLength()).toBe(0);
  });
});

describe("parseStack", () => {
  it("parses a typical Error", () => {
    const err = new Error("boom");
    const frames = parseStack(err);
    expect(frames.length).toBeGreaterThan(0);
    // Top frame should be in this test file.
    const top = frames[0]!;
    expect(top.in_app).toBe(true);
    expect(top.filename).toMatch(/index\.test/);
    expect(top.lineno).toBeTypeOf("number");
  });

  it("returns [] for Error with no stack", () => {
    const err = new Error("x");
    err.stack = undefined as unknown as string;
    expect(parseStack(err)).toEqual([]);
  });

  it("handles deep async stacks", () => {
    const stack = [
      "Error: async fail",
      "    at innerFn (/app/src/inner.ts:10:5)",
      "    at async outerFn (/app/src/outer.ts:20:10)",
      "    at async /app/src/entry.ts:30:1",
      "    at processTicksAndRejections (node:internal/process/task_queues:96:5)",
    ].join("\n");
    const frames = parseStack({ stack });
    expect(frames).toHaveLength(4);
    expect(frames[0]!.function).toBe("innerFn");
    expect(frames[0]!.in_app).toBe(true);
    expect(frames[1]!.function).toBe("outerFn");
    expect(frames[2]!.function).toBe(null);
    expect(frames[2]!.filename).toBe("/app/src/entry.ts");
    // node: frame is not in_app
    expect(frames[3]!.in_app).toBe(false);
  });

  it("handles minified-style frames with [as alias]", () => {
    const stack = [
      "Error: small",
      "    at Object.t [as fire] (/app/dist/min.js:1:42)",
      "    at /app/node_modules/foo/index.js:5:5",
    ].join("\n");
    const frames = parseStack({ stack });
    expect(frames).toHaveLength(2);
    expect(frames[0]!.function).toBe("Object.t");
    expect(frames[0]!.in_app).toBe(true);
    expect(frames[1]!.in_app).toBe(false);
  });

  it("returns [] for thrown string", () => {
    expect(parseStack("just a string")).toEqual([]);
  });

  it("returns [] for thrown null/undefined/number", () => {
    expect(parseStack(null)).toEqual([]);
    expect(parseStack(undefined)).toEqual([]);
    expect(parseStack(42)).toEqual([]);
  });

  it("marks node_modules and node: frames as not in_app", () => {
    const stack = [
      "Error: x",
      "    at userFn (/app/src/index.ts:1:1)",
      "    at libFn (/app/node_modules/lodash/index.js:5:5)",
      "    at internal (node:internal/process/task_queues:96:5)",
    ].join("\n");
    const frames = parseStack({ stack });
    expect(frames[0]!.in_app).toBe(true);
    expect(frames[1]!.in_app).toBe(false);
    expect(frames[2]!.in_app).toBe(false);
  });
});

describe("buildEventPayload", () => {
  it("falls back to release = deploySha when release unset", () => {
    const p = buildEventPayload(new Error("e"), undefined, { deploySha: "sha1" });
    expect(p.deploy_sha).toBe("sha1");
    expect(p.release).toBe("sha1");
  });

  it("attaches tags / extra / user from context", () => {
    const p = buildEventPayload(new Error("e"), {
      tags: { route: "/x" },
      extra: { reqId: "1" },
      user: { id: "u1" },
    }, {});
    expect(p.tags).toEqual({ route: "/x" });
    expect(p.extra).toEqual({ reqId: "1" });
    expect(p.user).toEqual({ id: "u1" });
  });
});
