import { AgentryClient, type InitOptions } from "./client.js";
import type { CaptureContext } from "./payload.js";

export { AgentryClient } from "./client.js";
export type { InitOptions } from "./client.js";
export type { CaptureContext } from "./payload.js";
export type { IngestEventPayload, StackFrame } from "@agentry/shared";

const client = new AgentryClient();

export function init(opts: InitOptions): void {
  client.init(opts);
}

export function capture(err: unknown, ctx?: CaptureContext): void {
  client.capture(err, ctx);
}

export function flush(timeoutMs?: number): Promise<boolean> {
  return client.flush(timeoutMs);
}

export function close(): Promise<void> {
  return client.close();
}

export const captureUncaught = (err: unknown): void => client.captureUncaught(err);

/** Default export: the singleton client surface, ergonomic for `agentry.init(...)`. */
export const agentry = {
  init,
  capture,
  flush,
  close,
  captureUncaught,
  /** Escape hatch for tests / advanced use. */
  _client: client,
};

export default agentry;
