import type { StackFrame } from "@agentry/shared";

// Browsers emit stacks in two main formats:
//   Chrome/Edge (V8): "    at functionName (file:line:col)" or "    at file:line:col"
//   Safari/Firefox:   "functionName@file:line:col" or "@file:line:col"
//
// We accept both and normalize.

const CHROME_FRAME_FN = /^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/;
const CHROME_FRAME_BARE = /^\s*at\s+(.+):(\d+):(\d+)\s*$/;
const SAFARI_FRAME = /^([^@]*)@(.+):(\d+):(\d+)\s*$/;

function isInApp(filename: string | null | undefined): boolean | null {
  // Hard to reliably detect in_app for browsers — bundles flatten everything.
  // Mark frames pointing to bundled vendor chunks as not-in_app, leave the rest null
  // so the server doesn't make wrong assumptions.
  if (!filename) return null;
  if (/\/(?:node_modules|vendor|chunk-[a-f0-9]+|polyfill)/.test(filename)) return false;
  return null;
}

function cleanFunctionName(raw: string): string {
  let fn = (raw ?? "").trim();
  if (fn.startsWith("async ")) fn = fn.slice("async ".length).trim();
  if (fn.startsWith("new ")) fn = fn.slice("new ".length).trim();
  fn = fn.replace(/\s*\[as\s+[^\]]+\]\s*$/, "");
  return fn;
}

export function parseStack(error: unknown): StackFrame[] {
  if (error === null || error === undefined) return [];
  if (typeof error !== "object" && !(error instanceof Error)) return [];

  const stack = (error as { stack?: unknown }).stack;
  if (typeof stack !== "string" || stack.length === 0) return [];

  const lines = stack.split("\n");
  const frames: StackFrame[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Chrome with function name
    let m = trimmed.match(CHROME_FRAME_FN);
    if (m) {
      const fn = cleanFunctionName(m[1] ?? "");
      const file = m[2] ?? "";
      const lineno = m[3] ? Number(m[3]) : null;
      const colno = m[4] ? Number(m[4]) : null;
      frames.push({
        function: fn || null,
        filename: file || null,
        lineno: lineno !== null && Number.isFinite(lineno) ? lineno : null,
        colno: colno !== null && Number.isFinite(colno) ? colno : null,
        in_app: isInApp(file),
      });
      continue;
    }

    // Chrome bare
    m = trimmed.match(CHROME_FRAME_BARE);
    if (m) {
      let file = m[1] ?? "";
      if (file.startsWith("async ")) file = file.slice("async ".length);
      const lineno = m[2] ? Number(m[2]) : null;
      const colno = m[3] ? Number(m[3]) : null;
      frames.push({
        function: null,
        filename: file || null,
        lineno: lineno !== null && Number.isFinite(lineno) ? lineno : null,
        colno: colno !== null && Number.isFinite(colno) ? colno : null,
        in_app: isInApp(file),
      });
      continue;
    }

    // Safari/Firefox: fn@file:L:C  (or @file:L:C)
    m = trimmed.match(SAFARI_FRAME);
    if (m) {
      const fn = cleanFunctionName(m[1] ?? "");
      const file = m[2] ?? "";
      const lineno = m[3] ? Number(m[3]) : null;
      const colno = m[4] ? Number(m[4]) : null;
      frames.push({
        function: fn || null,
        filename: file || null,
        lineno: lineno !== null && Number.isFinite(lineno) ? lineno : null,
        colno: colno !== null && Number.isFinite(colno) ? colno : null,
        in_app: isInApp(file),
      });
      continue;
    }
    // Skip unrecognized lines (often the leading message line on Chrome).
  }

  return frames;
}
