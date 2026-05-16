import type { IngestEventPayload, StackFrame } from "@agentrysh/shared";
import { parseStack } from "./stack.js";

export interface CaptureContext {
  extra?: Record<string, unknown>;
  tags?: Record<string, string>;
  user?: Record<string, unknown>;
}

export interface BuildPayloadOpts {
  environment?: string;
  release?: string;
  deploySha?: string;
}

interface NormalizedError {
  type: string;
  value: string;
  frames: StackFrame[];
}

function normalizeError(err: unknown): NormalizedError {
  if (err instanceof Error) {
    return {
      type: err.name || "Error",
      value: err.message ?? "",
      frames: parseStack(err),
    };
  }
  if (typeof err === "string") return { type: "Error", value: err, frames: [] };
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return { type: "Error", value: String(err), frames: [] };
  }
  if (err === null) return { type: "Error", value: "null", frames: [] };
  if (err === undefined) return { type: "Error", value: "undefined", frames: [] };
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const name = typeof obj["name"] === "string" ? (obj["name"] as string) : null;
    const ctorName = (err as { constructor?: { name?: string } }).constructor?.name;
    const type = name || ctorName || "Object";
    let value: string;
    if (typeof obj["message"] === "string") value = obj["message"] as string;
    else {
      try { value = JSON.stringify(err); }
      catch { value = "[unserializable]"; }
    }
    return { type, value, frames: parseStack(err) };
  }
  return { type: "Error", value: String(err), frames: [] };
}

export function buildEventPayload(
  err: unknown,
  ctx: CaptureContext | undefined,
  opts: BuildPayloadOpts,
): IngestEventPayload {
  const normalized = normalizeError(err);
  const eventId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
    ? globalThis.crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

  const payload: IngestEventPayload = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    exception: {
      values: [
        {
          type: normalized.type,
          value: normalized.value,
          stacktrace: { frames: normalized.frames },
        },
      ],
    },
  };

  if (opts.environment) payload.environment = opts.environment;
  if (opts.deploySha) {
    payload.deploy_sha = opts.deploySha;
    payload.release = opts.release ?? opts.deploySha;
  } else if (opts.release) {
    payload.release = opts.release;
  }

  // Browser context: page url is useful even for analytics agents.
  try {
    const win = globalThis as unknown as { location?: { href?: string }; navigator?: { userAgent?: string } };
    if (win.location?.href) {
      payload.request = { url: win.location.href };
    }
    if (win.navigator?.userAgent) {
      payload.tags = { ...(payload.tags ?? {}), user_agent: String(win.navigator.userAgent).slice(0, 200) };
    }
  } catch {
    // ignore — non-browser env, just don't enrich
  }

  if (ctx?.tags) payload.tags = { ...(payload.tags ?? {}), ...ctx.tags };
  if (ctx?.extra) payload.extra = { ...ctx.extra };
  if (ctx?.user) payload.user = { ...ctx.user };

  return payload;
}
