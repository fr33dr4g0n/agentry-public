// Browser SDK tests. We stub the browser globals on globalThis since vitest
// runs in Node by default. happy-dom would also work but stubbing keeps the
// tests narrowly focused.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserAgentryClient } from "./client.js";
import { parseStack } from "./stack.js";
import { buildEventPayload } from "./payload.js";

const DSN = "agnt_proj-abc-123.tok_secrettoken_456";
const PROJECT_ID = "proj-abc-123";
const SERVER_URL = "https://ingest.test";

interface FakeWindow {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}
interface FakeDoc {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  visibilityState: string;
}

function installBrowserGlobals() {
  const fakeWindow: FakeWindow = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const fakeDoc: FakeDoc = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    visibilityState: "visible",
  };
  const fakeNav = {
    sendBeacon: vi.fn(() => true),
    userAgent: "Mozilla/5.0 (test)",
    language: "en-US",
  };
  const fakeLoc = { href: "https://my-app.test/page", pathname: "/page" };
  const fakeStorage: Record<string, string> = {};
  const ls = {
    getItem: (k: string) => fakeStorage[k] ?? null,
    setItem: (k: string, v: string) => { fakeStorage[k] = v; },
    removeItem: (k: string) => { delete fakeStorage[k]; },
  };

  (globalThis as unknown as { window: FakeWindow }).window = fakeWindow;
  (globalThis as unknown as { document: FakeDoc }).document = fakeDoc;
  (globalThis as unknown as { navigator: typeof fakeNav }).navigator = fakeNav;
  (globalThis as unknown as { location: typeof fakeLoc }).location = fakeLoc;
  (globalThis as unknown as { localStorage: typeof ls }).localStorage = ls;

  // We intentionally do NOT stub Blob — Node 18+ has it natively.

  return { fakeWindow, fakeDoc, fakeNav, fakeLoc };
}

function uninstallBrowserGlobals() {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).navigator;
  delete (globalThis as Record<string, unknown>).location;
  delete (globalThis as Record<string, unknown>).localStorage;
}

function mockFetch(status = 204) {
  const fn = vi.fn(async () => new Response(null, { status }));
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  uninstallBrowserGlobals();
  vi.restoreAllMocks();
});

describe("BrowserAgentryClient.init", () => {
  it("rejects malformed DSN and disables capture", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = new BrowserAgentryClient();
    c.init({ dsn: "garbage" });
    expect(c._isInitialized()).toBe(false);
    c.capture(new Error("x"));
    expect(c._getQueueLength()).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("attaches window 'error' and 'unhandledrejection' listeners by default", () => {
    const { fakeWindow } = installBrowserGlobals();
    const c = new BrowserAgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });
    expect(fakeWindow.addEventListener).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
    expect(fakeWindow.addEventListener).toHaveBeenCalledWith(
      "unhandledrejection",
      expect.any(Function),
    );
  });

  it("autoCaptureGlobalErrors=false skips listeners", () => {
    const { fakeWindow } = installBrowserGlobals();
    const c = new BrowserAgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL, autoCaptureGlobalErrors: false });
    expect(fakeWindow.addEventListener).not.toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
  });
});

describe("BrowserAgentryClient.capture / flush", () => {
  it("posts to /v1/store/:project_id/ with Bearer DSN, includes browser url + UA tag", async () => {
    installBrowserGlobals();
    const fetchMock = mockFetch(204);
    const c = new BrowserAgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL, environment: "production" });
    c.capture(new Error("kaboom"));
    const ok = await c.flush();
    expect(ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${SERVER_URL}/v1/store/${PROJECT_ID}/`);
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${DSN}`);
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.platform).toBe("javascript");
    expect((body.request as { url: string }).url).toBe("https://my-app.test/page");
    expect((body.tags as { user_agent: string }).user_agent).toContain("Mozilla");
  });

  it("captures non-Error throws (string, null, plain object)", async () => {
    installBrowserGlobals();
    mockFetch(204);
    const c = new BrowserAgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });
    c.capture("plain string");
    c.capture(null);
    c.capture({ name: "CustomError", message: "obj" });
    expect(c._getQueueLength()).toBe(3);
    await c.flush();
  });

  it("retains queue on 5xx, drops on 4xx", async () => {
    installBrowserGlobals();
    const c = new BrowserAgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });

    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof globalThis.fetch;
    c.capture(new Error("a"));
    let ok = await c.flush();
    expect(ok).toBe(false);
    expect(c._getQueueLength()).toBe(1);

    globalThis.fetch = vi.fn(async () => new Response(null, { status: 400 })) as unknown as typeof globalThis.fetch;
    ok = await c.flush();
    expect(ok).toBe(true);
    expect(c._getQueueLength()).toBe(0);
  });

  it("global 'error' listener handler captures into the queue", () => {
    const { fakeWindow } = installBrowserGlobals();
    const c = new BrowserAgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });
    // Find the registered handler
    const calls = fakeWindow.addEventListener.mock.calls;
    const errCall = calls.find((args: unknown[]) => args[0] === "error");
    expect(errCall).toBeDefined();
    const handler = errCall![1] as (ev: ErrorEvent) => void;
    handler({ error: new Error("from listener"), message: "from listener" } as ErrorEvent);
    expect(c._getQueueLength()).toBe(1);
  });
});

describe("BrowserAgentryClient.track", () => {
  it("posts to /v1/track with browser-enriched properties + persisted distinct_id", async () => {
    installBrowserGlobals();
    const fetchMock = mockFetch(200);
    const c = new BrowserAgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });
    const ok = await c.track("page_view");
    expect(ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${SERVER_URL}/v1/track/${PROJECT_ID}/`);
    const body = JSON.parse((init as RequestInit).body as string) as {
      event: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    };
    expect(body.event).toBe("page_view");
    expect(typeof body.distinct_id).toBe("string");
    expect(body.distinct_id.length).toBeGreaterThan(0);
    expect(body.properties.$current_url).toBe("https://my-app.test/page");
    expect(body.properties.$user_agent).toContain("Mozilla");
  });

  it("explicit distinctId wins over generated one", async () => {
    installBrowserGlobals();
    const fetchMock = mockFetch(200);
    const c = new BrowserAgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });
    await c.track("checkout", { distinctId: "user_42" });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as {
      distinct_id: string;
    };
    expect(body.distinct_id).toBe("user_42");
  });

  it("stable distinct_id across calls", async () => {
    installBrowserGlobals();
    const fetchMock = mockFetch(200);
    const c = new BrowserAgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });
    await c.track("a");
    await c.track("b");
    const id1 = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).distinct_id;
    const id2 = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).distinct_id;
    expect(id1).toBe(id2);
  });
});

describe("BrowserAgentryClient.flushBeacon", () => {
  it("uses navigator.sendBeacon when events are queued", () => {
    const globals = installBrowserGlobals();
    mockFetch(204);
    const c = new BrowserAgentryClient();
    c.init({ dsn: DSN, serverUrl: SERVER_URL });
    c.capture(new Error("survive unload"));
    expect(c._getQueueLength()).toBe(1);
    const ok = c.flushBeacon();
    expect(ok).toBe(true);
    expect(globals.fakeNav.sendBeacon).toHaveBeenCalledTimes(1);
    expect(c._getQueueLength()).toBe(0);
  });
});

describe("parseStack", () => {
  it("parses Chrome (V8) format", () => {
    const stack = `Error: x
    at handleClick (https://app.test/main.js:42:15)
    at HTMLButtonElement.<anonymous> (https://app.test/main.js:88:9)`;
    const frames = parseStack({ stack } as unknown);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.function).toBe("handleClick");
    expect(frames[0]!.filename).toBe("https://app.test/main.js");
    expect(frames[0]!.lineno).toBe(42);
  });

  it("parses Safari/Firefox format (fn@file:L:C)", () => {
    const stack = `handleClick@https://app.test/main.js:42:15
@https://app.test/main.js:88:9`;
    const frames = parseStack({ stack } as unknown);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.function).toBe("handleClick");
    expect(frames[1]!.function).toBe(null);
    expect(frames[1]!.filename).toBe("https://app.test/main.js");
  });

  it("flags vendor chunks as not in_app", () => {
    const stack = `at fn (https://app.test/assets/vendor/react.js:1:1)`;
    const frames = parseStack({ stack } as unknown);
    expect(frames[0]!.in_app).toBe(false);
  });

  it("returns [] for thrown string / null", () => {
    expect(parseStack("oops")).toEqual([]);
    expect(parseStack(null)).toEqual([]);
  });
});

describe("buildEventPayload", () => {
  it("falls back to release = deploySha", () => {
    const p = buildEventPayload(new Error("x"), undefined, { deploySha: "abc123" });
    expect(p.deploy_sha).toBe("abc123");
    expect(p.release).toBe("abc123");
  });

  it("uses Math.random fallback when crypto.randomUUID is missing", () => {
    const original = globalThis.crypto?.randomUUID;
    if (globalThis.crypto) {
      Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
    }
    const p = buildEventPayload(new Error("x"), undefined, {});
    expect(typeof p.event_id).toBe("string");
    expect(p.event_id!.length).toBeGreaterThan(0);
    if (globalThis.crypto && original) {
      Object.defineProperty(globalThis.crypto, "randomUUID", { value: original, configurable: true });
    }
  });
});
