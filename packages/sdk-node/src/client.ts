import { parseDsn, type IngestEventPayload } from "@agentry/shared";
import { buildEventPayload, type CaptureContext } from "./payload.js";

export interface InitOptions {
  dsn: string;
  /** Identifies the deploy that emitted this error. Becomes both `deploy_sha` and `release`. */
  deploySha?: string;
  /** Optional environment tag, e.g. "production", "staging". */
  environment?: string;
  /** Override the ingest server. Defaults to https://api.agentry.dev */
  serverUrl?: string;
  /** Explicit release identifier. Falls back to `deploySha` when unset. */
  release?: string;
  /** Optional server hostname to tag events with. */
  serverName?: string;
  /** How often the SDK auto-flushes the queue. Default 5000ms. Set 0 to disable. */
  flushIntervalMs?: number;
}

const DEFAULT_SERVER_URL = "https://api.agentry.dev";
const MAX_BUFFERED_EVENTS = 1000;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;

interface ResolvedConfig {
  dsn: string;
  ingestUrl: string;
  trackUrl: string;
  deployUrl: string;
  serverUrl: string;
  projectId: string;
  environment?: string;
  release?: string;
  deploySha?: string;
  serverName?: string;
}

export interface DeployOptions {
  sha: string;
  branch?: string;
  environment?: string;
  message?: string;
  url?: string;
  actor?: string;
}

export interface TrackOptions {
  /** Identify the actor for the event. PostHog calls this `distinct_id`. */
  distinctId?: string;
  properties?: Record<string, unknown>;
}

export class AgentryClient {
  private config: ResolvedConfig | null = null;
  private events: IngestEventPayload[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private beforeExitHandler: (() => void) | null = null;
  private warnedNotInitialized = false;
  private warnedInvalidDsn = false;

  init(opts: InitOptions): void {
    if (!opts || typeof opts.dsn !== "string" || opts.dsn.length === 0) {
      if (!this.warnedInvalidDsn) {
        // eslint-disable-next-line no-console
        console.warn("[agentry] init() called without a dsn — capture() is disabled");
        this.warnedInvalidDsn = true;
      }
      return;
    }
    const parsed = parseDsn(opts.dsn);
    if (!parsed) {
      if (!this.warnedInvalidDsn) {
        // eslint-disable-next-line no-console
        console.warn("[agentry] dsn is malformed — capture() is disabled");
        this.warnedInvalidDsn = true;
      }
      return;
    }

    const serverUrl = (opts.serverUrl ?? DEFAULT_SERVER_URL).replace(/\/+$/, "");
    const ingestUrl = `${serverUrl}/v1/store/${parsed.projectId}/`;
    const trackUrl = `${serverUrl}/v1/track/${parsed.projectId}/`;
    const deployUrl = `${serverUrl}/v1/deploys/${parsed.projectId}/`;

    const config: ResolvedConfig = {
      dsn: opts.dsn,
      ingestUrl,
      trackUrl,
      deployUrl,
      serverUrl,
      projectId: parsed.projectId,
    };
    if (opts.environment !== undefined) config.environment = opts.environment;
    if (opts.release !== undefined) config.release = opts.release;
    if (opts.deploySha !== undefined) config.deploySha = opts.deploySha;
    if (opts.serverName !== undefined) config.serverName = opts.serverName;
    this.config = config;

    const interval = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.startFlushTimer(interval);
    this.installBeforeExit();
  }

  /**
   * Synchronous: builds the payload, enqueues, returns. Network I/O is deferred
   * to the next flush. Safe to call without `await`.
   */
  capture(err: unknown, ctx?: CaptureContext): void {
    if (!this.config) {
      if (!this.warnedNotInitialized) {
        // eslint-disable-next-line no-console
        console.warn("[agentry] capture() called before init() — event dropped");
        this.warnedNotInitialized = true;
      }
      return;
    }

    const opts: Parameters<typeof buildEventPayload>[2] = {};
    if (this.config.environment !== undefined) opts.environment = this.config.environment;
    if (this.config.release !== undefined) opts.release = this.config.release;
    if (this.config.deploySha !== undefined) opts.deploySha = this.config.deploySha;
    if (this.config.serverName !== undefined) opts.serverName = this.config.serverName;

    const payload = buildEventPayload(err, ctx, opts);
    this.events.push(payload);
    if (this.events.length > MAX_BUFFERED_EVENTS) {
      // Should rarely happen between flushes; cap aggressively to bound memory.
      this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
    }
  }

  /** Convenience wrapper for `process.on("uncaughtException", ...)`. */
  captureUncaught = (err: unknown): void => {
    this.capture(err, { tags: { uncaught: "true" } });
  };

  /**
   * Track an analytics event. Fire-and-forget; resolves once the request returns.
   * Returns false if the SDK is not initialized or the request failed (4xx/5xx/timeout).
   */
  async track(event: string, opts: TrackOptions = {}, timeoutMs = 5000): Promise<boolean> {
    if (!this.config) {
      this.warnNotInitialized();
      return false;
    }
    if (!event || typeof event !== "string") return false;

    const config = this.config;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await globalThis.fetch(config.trackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.dsn}`,
        },
        body: JSON.stringify({
          event,
          distinct_id: opts.distinctId,
          properties: opts.properties ?? {},
          timestamp: Math.floor(Date.now() / 1000),
        }),
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Record a deploy event. Call this from your CI after a successful deploy
   * (e.g. in the same step that publishes the build). Cases ingested after a
   * deploy will surface that deploy in their `recent_deploys` to help agents
   * attribute regressions.
   */
  async deploy(opts: DeployOptions, timeoutMs = 5000): Promise<boolean> {
    if (!this.config) {
      this.warnNotInitialized();
      return false;
    }
    if (!opts.sha) return false;

    const config = this.config;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await globalThis.fetch(config.deployUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.dsn}`,
        },
        body: JSON.stringify({
          sha: opts.sha,
          branch: opts.branch,
          environment: opts.environment,
          message: opts.message,
          url: opts.url,
          actor: opts.actor,
        }),
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private warnNotInitialized(): void {
    if (!this.warnedNotInitialized) {
      // eslint-disable-next-line no-console
      console.warn("[agentry] called before init() — no-op");
      this.warnedNotInitialized = true;
    }
  }

  /**
   * Send all queued events. Returns true if everything was delivered (or
   * intentionally dropped as 4xx), false if the request didn't complete
   * within `timeoutMs`.
   */
  async flush(timeoutMs = 2000): Promise<boolean> {
    if (!this.config) return true;
    if (this.events.length === 0) return true;

    const config = this.config;
    const batch = this.events;
    this.events = [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Sentry's /store/ endpoint takes one event per POST. We fan out in
    // parallel and partition the batch into retryable / dropped on response.
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
      // Shouldn't happen because each fetch is wrapped, but be safe.
      this.requeue(batch);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Stop the flush timer, detach hooks, and best-effort flush. */
  async close(): Promise<void> {
    this.stopFlushTimer();
    this.uninstallBeforeExit();
    await this.flush();
  }

  private requeue(batch: IngestEventPayload[]): void {
    // Prepend the unsent batch, then trim to cap.
    this.events = [...batch, ...this.events];
    if (this.events.length > MAX_BUFFERED_EVENTS) {
      // Drop oldest (front) — newer events are more likely to be relevant.
      this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
    }
  }

  private startFlushTimer(intervalMs: number): void {
    this.stopFlushTimer();
    if (intervalMs <= 0) return;
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => {
        // swallowed; flush already handled requeue
      });
    }, intervalMs);
    // Don't keep the event loop alive just for our flush timer.
    if (typeof (this.flushTimer as { unref?: () => void }).unref === "function") {
      (this.flushTimer as { unref: () => void }).unref();
    }
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private installBeforeExit(): void {
    if (this.beforeExitHandler) return;
    if (typeof process === "undefined" || typeof process.on !== "function") return;
    this.beforeExitHandler = () => {
      void this.flush().catch(() => {});
    };
    process.on("beforeExit", this.beforeExitHandler);
  }

  private uninstallBeforeExit(): void {
    if (!this.beforeExitHandler) return;
    if (typeof process !== "undefined" && typeof process.off === "function") {
      process.off("beforeExit", this.beforeExitHandler);
    }
    this.beforeExitHandler = null;
  }

  // ----- test helpers (not part of the public API) -----

  /** @internal */
  _getQueueLength(): number {
    return this.events.length;
  }

  /** @internal */
  _isInitialized(): boolean {
    return this.config !== null;
  }
}
