import { parseDsn, type IngestEventPayload } from "@agentrysh/shared";
import { buildEventPayload, type CaptureContext } from "./payload.js";

function serializeForLog(payload: unknown): unknown {
  if (payload instanceof Error) {
    return {
      kind: "error",
      name: payload.name,
      message: payload.message,
      stack: payload.stack,
    };
  }
  if (payload === null || payload === undefined) {
    return { kind: "log", value: payload === null ? "null" : "undefined" };
  }
  if (typeof payload !== "object") {
    return { kind: "log", value: String(payload) };
  }
  return payload;
}

export interface InitOptions {
  dsn: string;
  /** Identifies the deploy that emitted this error. Becomes both `deploy_sha` and `release`. */
  deploySha?: string;
  /** Optional environment tag, e.g. "production", "staging". */
  environment?: string;
  /** Override the ingest server. Defaults to https://api.agentry.sh */
  serverUrl?: string;
  /** Explicit release identifier. Falls back to `deploySha` when unset. */
  release?: string;
  /** Auto-flush interval in ms. Default 5000. Set 0 to disable. */
  flushIntervalMs?: number;
  /** Auto-attach window 'error' and 'unhandledrejection' listeners. Default true. */
  autoCaptureGlobalErrors?: boolean;
}

export interface TrackOptions {
  /** PostHog distinct_id; falls back to a session-stable random id. */
  distinctId?: string;
  properties?: Record<string, unknown>;
}

export interface UserContext {
  id: string;
  email?: string;
  username?: string;
  traits?: Record<string, unknown>;
}

const DEFAULT_SERVER_URL = "https://api.agentry.sh";
const MAX_BUFFERED_EVENTS = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const STORAGE_KEY = "agentry_distinct_id";

interface ResolvedConfig {
  dsn: string;
  ingestUrl: string;
  trackUrl: string;
  logUrl: string;
  serverUrl: string;
  projectId: string;
  environment?: string;
  release?: string;
  deploySha?: string;
}

function isBrowserLike(): boolean {
  return typeof globalThis !== "undefined"
    && typeof (globalThis as { window?: unknown }).window !== "undefined";
}

function getOrCreateDistinctId(): string {
  // Persist across page loads so analytics events are user-stable.
  try {
    const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    if (ls) {
      const existing = ls.getItem(STORAGE_KEY);
      if (existing) return existing;
      const id =
        (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
      ls.setItem(STORAGE_KEY, id);
      return id;
    }
  } catch {
    // localStorage may throw in private mode / cross-origin iframes
  }
  return "anon-" + Math.random().toString(36).slice(2);
}

export class BrowserAgentryClient {
  private config: ResolvedConfig | null = null;
  private events: IngestEventPayload[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private warnedNotInitialized = false;
  private warnedInvalidDsn = false;
  private listenersInstalled = false;
  private boundOnError: ((ev: ErrorEvent) => void) | null = null;
  private boundOnRejection: ((ev: PromiseRejectionEvent) => void) | null = null;
  private boundOnVisibilityChange: (() => void) | null = null;
  private user: UserContext | null = null;

  /**
   * Identify the current user. After this, capture() and track() automatically
   * include the user (id replaces the auto-generated localStorage distinct_id
   * so server- and client-side analytics stay correlated).
   */
  setUser(user: UserContext | null): void {
    this.user = user && typeof user.id === "string" && user.id.length > 0 ? user : null;
    if (this.user) {
      // Persist as the new distinct_id so it survives reloads.
      try {
        const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
        if (ls) ls.setItem(STORAGE_KEY, this.user.id);
      } catch {
        // private mode / cross-origin iframe — ignore
      }
    }
  }
  identify(user: UserContext): void { this.setUser(user); }
  clearUser(): void {
    this.user = null;
    try {
      const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
      if (ls) ls.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  init(opts: InitOptions): void {
    if (!opts || typeof opts.dsn !== "string" || opts.dsn.length === 0) {
      this.warnInvalidDsn("init() called without a dsn");
      return;
    }
    const parsed = parseDsn(opts.dsn);
    if (!parsed) {
      this.warnInvalidDsn("init() called with malformed dsn");
      return;
    }

    const serverUrl = (opts.serverUrl ?? DEFAULT_SERVER_URL).replace(/\/+$/, "");
    const config: ResolvedConfig = {
      dsn: opts.dsn,
      serverUrl,
      projectId: parsed.projectId,
      ingestUrl: `${serverUrl}/v1/store/${parsed.projectId}/`,
      trackUrl: `${serverUrl}/v1/track/${parsed.projectId}/`,
      logUrl: `${serverUrl}/v1/log/${parsed.projectId}/`,
    };
    if (opts.environment !== undefined) config.environment = opts.environment;
    if (opts.release !== undefined) config.release = opts.release;
    if (opts.deploySha !== undefined) config.deploySha = opts.deploySha;
    this.config = config;

    const interval = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.startFlushTimer(interval);

    const auto = opts.autoCaptureGlobalErrors ?? true;
    if (auto && isBrowserLike()) this.installGlobalListeners();
    if (isBrowserLike()) this.installVisibilityChange();
  }

  capture(err: unknown, ctx?: CaptureContext): void {
    if (!this.config) {
      this.warnNotInitialized();
      return;
    }
    const opts: Parameters<typeof buildEventPayload>[2] = {};
    if (this.config.environment !== undefined) opts.environment = this.config.environment;
    if (this.config.release !== undefined) opts.release = this.config.release;
    if (this.config.deploySha !== undefined) opts.deploySha = this.config.deploySha;

    const mergedCtx: CaptureContext = ctx ? { ...ctx } : {};
    if (this.user && !mergedCtx.user) {
      const u: Record<string, unknown> = { id: this.user.id };
      if (this.user.email) u.email = this.user.email;
      if (this.user.username) u.username = this.user.username;
      if (this.user.traits) Object.assign(u, this.user.traits);
      mergedCtx.user = u;
    }

    const payload = buildEventPayload(err, mergedCtx, opts);
    this.events.push(payload);
    if (this.events.length > MAX_BUFFERED_EVENTS) {
      this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
    }
  }

  /**
   * Just like console.log — agentry.log(anything). The server figures out whether
   * it's an error, deploy, analytics event, or generic log line and routes it.
   */
  async log(payload: unknown, timeoutMs = 5000): Promise<boolean> {
    if (!this.config) {
      this.warnNotInitialized();
      return false;
    }
    const config = this.config;
    const body = serializeForLog(payload);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await globalThis.fetch(config.logUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.dsn}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        mode: "cors",
        credentials: "omit",
      });
      return res.ok || res.status === 202;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async track(event: string, opts: TrackOptions = {}, timeoutMs = 5000): Promise<boolean> {
    if (!this.config) {
      this.warnNotInitialized();
      return false;
    }
    if (!event || typeof event !== "string") return false;
    const config = this.config;

    const distinctId = opts.distinctId ?? this.user?.id ?? getOrCreateDistinctId();
    const enriched = this.enrichBrowserProperties(opts.properties ?? {});
    if (this.user?.email) enriched.$user_email = this.user.email;
    if (this.user?.username) enriched.$user_username = this.user.username;
    const payload = {
      event,
      distinct_id: distinctId,
      properties: enriched,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await globalThis.fetch(config.trackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.dsn}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        // CORS: agentry serves Access-Control-Allow-Origin: * on /v1/track/*
        mode: "cors",
        credentials: "omit",
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async flush(timeoutMs = 2000): Promise<boolean> {
    if (!this.config) return true;
    if (this.events.length === 0) return true;

    const config = this.config;
    const batch = this.events;
    this.events = [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const sendOne = async (ev: IngestEventPayload): Promise<"ok" | "retry" | "drop"> => {
      try {
        const res = await globalThis.fetch(config.ingestUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.dsn}`,
          },
          body: JSON.stringify(ev),
          signal: controller.signal,
          mode: "cors",
          credentials: "omit",
        });
        if (res.ok) return "ok";
        if (res.status === 429 || res.status >= 500) return "retry";
        return "drop";
      } catch {
        return "retry";
      }
    };

    try {
      const results = await Promise.all(batch.map(sendOne));
      const toRequeue: IngestEventPayload[] = [];
      let allOk = true;
      for (let i = 0; i < batch.length; i++) {
        if (results[i] === "retry") {
          toRequeue.push(batch[i]!);
          allOk = false;
        }
      }
      if (toRequeue.length > 0) this.requeue(toRequeue);
      return allOk;
    } catch {
      this.requeue(batch);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Best-effort flush via sendBeacon. Survives page unload (unlike fetch).
   * Returns true if every queued event was handed off to the browser.
   */
  flushBeacon(): boolean {
    if (!this.config || this.events.length === 0) return true;
    const nav = (globalThis as unknown as { navigator?: { sendBeacon?: (u: string, b: BodyInit) => boolean } }).navigator;
    if (!nav?.sendBeacon) return false;

    const config = this.config;
    let allHandedOff = true;
    for (const ev of this.events) {
      const blob = new Blob(
        [JSON.stringify({ ...ev, _agentry_dsn: config.dsn })],
        { type: "application/json" },
      );
      // sendBeacon can't set headers, so we rely on the body containing the DSN.
      // The server checks for `_agentry_dsn` in the JSON body as a fallback auth.
      const ok = nav.sendBeacon(config.ingestUrl, blob);
      if (!ok) allHandedOff = false;
    }
    if (allHandedOff) this.events = [];
    return allHandedOff;
  }

  async close(): Promise<void> {
    this.stopFlushTimer();
    this.uninstallGlobalListeners();
    this.uninstallVisibilityChange();
    await this.flush();
  }

  // ------------ internals ------------

  private requeue(batch: IngestEventPayload[]): void {
    this.events = [...batch, ...this.events];
    if (this.events.length > MAX_BUFFERED_EVENTS) {
      this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
    }
  }

  private startFlushTimer(intervalMs: number): void {
    this.stopFlushTimer();
    if (intervalMs <= 0) return;
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => {});
    }, intervalMs);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private installGlobalListeners(): void {
    if (this.listenersInstalled) return;
    const w = (globalThis as unknown as { window?: Window }).window;
    if (!w) return;

    this.boundOnError = (ev: ErrorEvent) => {
      this.capture(ev.error ?? ev.message ?? "unknown error", {
        tags: { uncaught: "true" },
      });
    };
    this.boundOnRejection = (ev: PromiseRejectionEvent) => {
      this.capture(ev.reason, { tags: { unhandled_rejection: "true" } });
    };

    w.addEventListener("error", this.boundOnError);
    w.addEventListener("unhandledrejection", this.boundOnRejection);
    this.listenersInstalled = true;
  }

  private uninstallGlobalListeners(): void {
    if (!this.listenersInstalled) return;
    const w = (globalThis as unknown as { window?: Window }).window;
    if (w) {
      if (this.boundOnError) w.removeEventListener("error", this.boundOnError);
      if (this.boundOnRejection)
        w.removeEventListener("unhandledrejection", this.boundOnRejection);
    }
    this.boundOnError = null;
    this.boundOnRejection = null;
    this.listenersInstalled = false;
  }

  private installVisibilityChange(): void {
    if (this.boundOnVisibilityChange) return;
    const doc = (globalThis as unknown as { document?: Document }).document;
    if (!doc) return;
    this.boundOnVisibilityChange = () => {
      if (doc.visibilityState === "hidden") {
        // Best effort: try sendBeacon first (survives unload), then fall back to flush.
        const sent = this.flushBeacon();
        if (!sent) void this.flush(1500).catch(() => {});
      }
    };
    doc.addEventListener("visibilitychange", this.boundOnVisibilityChange);
  }

  private uninstallVisibilityChange(): void {
    if (!this.boundOnVisibilityChange) return;
    const doc = (globalThis as unknown as { document?: Document }).document;
    if (doc) doc.removeEventListener("visibilitychange", this.boundOnVisibilityChange);
    this.boundOnVisibilityChange = null;
  }

  private enrichBrowserProperties(props: Record<string, unknown>): Record<string, unknown> {
    try {
      const w = globalThis as unknown as {
        location?: { href?: string; pathname?: string };
        document?: { referrer?: string };
        navigator?: { userAgent?: string; language?: string };
      };
      const enriched: Record<string, unknown> = { ...props };
      if (w.location?.href) enriched.$current_url = w.location.href;
      if (w.location?.pathname) enriched.$pathname = w.location.pathname;
      if (w.document?.referrer) enriched.$referrer = w.document.referrer;
      if (w.navigator?.userAgent) enriched.$user_agent = w.navigator.userAgent;
      if (w.navigator?.language) enriched.$language = w.navigator.language;
      return enriched;
    } catch {
      return props;
    }
  }

  private warnNotInitialized(): void {
    if (this.warnedNotInitialized) return;
    this.warnedNotInitialized = true;
    try { console.warn("[agentry] called before init() — no-op"); } catch {}
  }

  private warnInvalidDsn(reason: string): void {
    if (this.warnedInvalidDsn) return;
    this.warnedInvalidDsn = true;
    try { console.warn(`[agentry] ${reason}`); } catch {}
  }

  /** @internal */
  _getQueueLength(): number { return this.events.length; }
  /** @internal */
  _isInitialized(): boolean { return this.config !== null; }
}
