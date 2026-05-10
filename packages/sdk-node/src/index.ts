import { AgentryClient, type DeployOptions, type InitOptions, type TrackOptions, type UserContext } from "./client.js";
import type { CaptureContext } from "./payload.js";

export { AgentryClient } from "./client.js";
export type { InitOptions, DeployOptions, TrackOptions, UserContext } from "./client.js";
export type { CaptureContext } from "./payload.js";
export type { IngestEventPayload, StackFrame } from "@agentry/shared";

const client = new AgentryClient();

export function init(opts: InitOptions): void {
  client.init(opts);
}

export function capture(err: unknown, ctx?: CaptureContext): void {
  client.capture(err, ctx);
}

export function track(event: string, opts?: TrackOptions): Promise<boolean> {
  return client.track(event, opts);
}

export function deploy(opts: DeployOptions): Promise<boolean> {
  return client.deploy(opts);
}

export function log(payload: unknown): Promise<boolean> {
  return client.log(payload);
}

export function setUser(user: UserContext | null): void { client.setUser(user); }
export function identify(user: UserContext): void { client.identify(user); }
export function clearUser(): void { client.clearUser(); }

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
  track,
  deploy,
  log,
  setUser,
  identify,
  clearUser,
  flush,
  close,
  captureUncaught,
  /** Escape hatch for tests / advanced use. */
  _client: client,
};

export default agentry;
