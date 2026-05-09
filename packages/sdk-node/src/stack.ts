import type { StackFrame } from "@agentry/shared";

// Match V8-style stack frames:
//   "    at functionName (file:line:col)"
//   "    at file:line:col"
//   "    at async functionName (file:line:col)"
//   "    at new ClassName (file:line:col)"
//   "    at Object.functionName [as x] (file:line:col)"
const FRAME_WITH_FUNCTION = /^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/;
const FRAME_BARE = /^\s*at\s+(.+):(\d+):(\d+)\s*$/;

function isInApp(filename: string | null | undefined): boolean {
  if (!filename) return false;
  if (filename.startsWith("node:")) return false;
  if (filename.includes("node_modules")) return false;
  // Internal node frames sometimes show as "internal/" or "(internal)"
  if (filename.startsWith("internal/")) return false;
  return true;
}

function cleanFunctionName(raw: string): string {
  // Strip leading "async " marker.
  let fn = raw.trim();
  if (fn.startsWith("async ")) fn = fn.slice("async ".length).trim();
  if (fn.startsWith("new ")) fn = fn.slice("new ".length).trim();
  // Strip "[as alias]" suffixes, e.g. "Object.fn [as x]"
  fn = fn.replace(/\s*\[as\s+[^\]]+\]\s*$/, "");
  return fn;
}

/**
 * Parse a thrown value's stack trace into structured frames.
 * - Error with `.stack`: parse V8 format (skips the message line)
 * - Error with no `.stack`: returns []
 * - non-Error object: returns []
 * - thrown string/number/etc: returns []
 *
 * Frames are returned in stack order (top frame first), matching the
 * order V8 emits.
 */
export function parseStack(error: unknown): StackFrame[] {
  if (error === null || error === undefined) return [];
  if (typeof error !== "object" && !(error instanceof Error)) return [];

  const stack = (error as { stack?: unknown }).stack;
  if (typeof stack !== "string" || stack.length === 0) return [];

  const lines = stack.split("\n");
  const frames: StackFrame[] = [];

  for (const line of lines) {
    if (!line.trim().startsWith("at ")) continue;

    let match = line.match(FRAME_WITH_FUNCTION);
    if (match) {
      const fnRaw = match[1] ?? "";
      const file = match[2] ?? "";
      const lineno = match[3] ? Number(match[3]) : null;
      const colno = match[4] ? Number(match[4]) : null;
      const fn = cleanFunctionName(fnRaw);
      frames.push({
        function: fn || null,
        filename: file || null,
        lineno: lineno !== null && Number.isFinite(lineno) ? lineno : null,
        colno: colno !== null && Number.isFinite(colno) ? colno : null,
        in_app: isInApp(file),
      });
      continue;
    }

    match = line.match(FRAME_BARE);
    if (match) {
      let file = match[1] ?? "";
      // V8 sometimes emits "at async file:L:C" without a function name.
      // Strip the leading "async " so the file path stays clean.
      if (file.startsWith("async ")) file = file.slice("async ".length);
      const lineno = match[2] ? Number(match[2]) : null;
      const colno = match[3] ? Number(match[3]) : null;
      frames.push({
        function: null,
        filename: file || null,
        lineno: lineno !== null && Number.isFinite(lineno) ? lineno : null,
        colno: colno !== null && Number.isFinite(colno) ? colno : null,
        in_app: isInApp(file),
      });
      continue;
    }
    // Unrecognized "at" line — skip silently. Better to drop one frame
    // than to emit garbage that breaks fingerprinting.
  }

  return frames;
}
