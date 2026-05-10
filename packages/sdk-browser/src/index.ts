import { BrowserAgentryClient, type InitOptions, type TrackOptions } from "./client.js";
import type { CaptureContext } from "./payload.js";

export { BrowserAgentryClient } from "./client.js";
export type { InitOptions, TrackOptions } from "./client.js";
export type { CaptureContext } from "./payload.js";
export type { IngestEventPayload, StackFrame } from "@agentry/shared";

const client = new BrowserAgentryClient();

export function init(opts: InitOptions): void { client.init(opts); }
export function capture(err: unknown, ctx?: CaptureContext): void { client.capture(err, ctx); }
export function track(event: string, opts?: TrackOptions): Promise<boolean> { return client.track(event, opts); }
export function flush(timeoutMs?: number): Promise<boolean> { return client.flush(timeoutMs); }
export function close(): Promise<void> { return client.close(); }

export const agentry = {
  init,
  capture,
  track,
  flush,
  close,
  /** Expose for advanced wiring (manual sendBeacon flush, etc.) */
  _client: client,
};

export default agentry;
