// Shared coercion helpers for inbound error payloads.
//
// agentry's typed /v1/errors/ endpoint and the catch-all /v1/log/ both need to
// accept the same range of "what an error looks like" shapes:
//
//   1) Sentry-protocol — already has `exception.values[0].{type, value, stacktrace.frames}`
//   2) The bare {name, message, stack} shape used by every install-guide.ts language helper
//      and by raw-HTTP callers (curl, Python `requests`, Go `net/http`, etc.)
//   3) Anything else — fall back to a no-stack Error so the request never 5xxs.
//
// Without this coercion, /v1/errors/ would extract `errorType = "Error"` for every bare-shape
// caller, breaking fingerprinting (all errors collapse into one Case named "Error").

import type { StackFrame } from "@agentrysh/shared";

export function coerceErrorBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    return {
      exception: {
        values: [{ type: "Error", value: String(body), stacktrace: { frames: [] } }],
      },
    };
  }
  const b = body as Record<string, unknown>;
  // Already Sentry-shape — pass through unchanged.
  if (b.exception) return b;

  // {name, message, stack} → Sentry envelope (preserve the original fields too,
  // so user/tags/extra/etc. survive into the typed handler).
  if (typeof b.name === "string" || typeof b.message === "string" || typeof b.stack === "string") {
    return {
      ...b,
      exception: {
        values: [
          {
            type: typeof b.name === "string"
              ? b.name
              : (typeof b.error_type === "string" ? b.error_type : "Error"),
            value: typeof b.message === "string" ? b.message : "",
            stacktrace: {
              frames: parseRawStack(typeof b.stack === "string" ? b.stack : ""),
            },
          },
        ],
      },
    };
  }
  // Nothing useful — treat the whole blob as a no-stack error so we never 5xx.
  return {
    exception: {
      values: [
        { type: "Error", value: JSON.stringify(b).slice(0, 500), stacktrace: { frames: [] } },
      ],
    },
  };
}

// Minimal V8-format stack parser for non-SDK callers (curl, raw HTTP from
// Python, etc). Best-effort; unparseable lines just skip — fingerprinting
// falls back to type+message.
export function parseRawStack(stack: string): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const m1 = line.match(/^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/);
    if (m1) {
      frames.push({
        function: m1[1] ?? null,
        filename: m1[2] ?? null,
        lineno: m1[3] ? Number(m1[3]) : null,
        colno: m1[4] ? Number(m1[4]) : null,
      });
      continue;
    }
    const m2 = line.match(/^\s*at\s+(.+):(\d+):(\d+)\s*$/);
    if (m2) {
      frames.push({
        function: null,
        filename: m2[1] ?? null,
        lineno: m2[2] ? Number(m2[2]) : null,
        colno: m2[3] ? Number(m2[3]) : null,
      });
    }
  }
  return frames;
}
