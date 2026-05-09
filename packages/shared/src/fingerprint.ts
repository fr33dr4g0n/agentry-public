import { sha1Hex } from "./crypto.js";
import type { StackFrame } from "./types.js";

const NODE_MODULES_RX = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?([^/]+)\//;

export function normalizeFilename(filename: string | undefined | null): string {
  if (!filename) return "";
  let f = filename.split("?")[0]!.split("#")[0]!;
  // Collapse nested node_modules paths so different lockfile layouts produce the same fingerprint.
  const m = f.match(NODE_MODULES_RX);
  if (m) {
    f = f.replace(NODE_MODULES_RX, `node_modules/${m[1]}/`);
  }
  return f;
}

export function pickAppFrame(frames: StackFrame[] | undefined): StackFrame | null {
  if (!frames || frames.length === 0) return null;
  // Prefer the first frame that's marked in_app, or the first non-node_modules, or the first one.
  for (const f of frames) {
    if (f.in_app === true) return f;
  }
  for (const f of frames) {
    if (f.filename && !/node_modules/.test(f.filename)) return f;
  }
  return frames[0]!;
}

export interface FingerprintInput {
  errorType: string | undefined | null;
  message: string | undefined | null;
  frames?: StackFrame[];
}

export async function computeFingerprint(input: FingerprintInput): Promise<string> {
  const errorType = (input.errorType ?? "Error").trim() || "Error";
  const top = pickAppFrame(input.frames);
  const fn = (top?.function ?? "").trim();
  const file = normalizeFilename(top?.filename ?? "");
  const line = top?.lineno ?? 0;

  // Fall back to message if there's no usable frame at all (e.g. `throw "string"`).
  if (!fn && !file) {
    const msg = (input.message ?? "").slice(0, 200);
    return await sha1Hex(`${errorType}::${msg}`);
  }

  return await sha1Hex(`${errorType}::${fn}::${file}::${line}`);
}
