// Server-side sourcemap translation. Sourcemap blobs live in R2; the
// `sourcemaps` table is the index keyed by (project_id, release_id, source_url).
// Translation happens at case-read time, not on ingest — the hot path stays
// fast and we only pay the cost when an agent actually investigates a case.
//
// Per-request memoization: a single GET /v1/cases/:id might touch several
// minified frames in 1–5 source files; loading + parsing each map once and
// reusing it across frames in the same request keeps it cheap.

import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { and, eq, inArray } from "drizzle-orm";
import { sourcemaps } from "@agentry/db/schema";
import type { StackFrame } from "@agentrysh/shared";
import { getDb } from "./db.js";
import type { Env } from "./env.js";

/** A stack frame after sourcemap translation. Extends StackFrame with the
 * original (un-minified) file/line/column when a map was available. */
export interface TranslatedStackFrame extends StackFrame {
  /** Original source path inferred from the sourcemap. */
  original_file?: string;
  /** Original line in the source file (1-indexed). */
  original_line?: number;
  /** Original column in the source file (0-indexed). */
  original_column?: number;
  /** Original function/identifier name from the sourcemap's `names` field. */
  original_name?: string;
  /** True if this frame was successfully translated. */
  unmangled?: boolean;
}

/** Map of `source_url → TraceMap` populated per-request to memoize across frames. */
type LoadedMapCache = Map<string, TraceMap | null>;

/** Translate a stack trace using sourcemaps stored for `(projectId, releaseId)`.
 *
 * If `releaseId` is falsy (no deploy SHA on the event), falls back to maps
 * uploaded under the literal release id `"default"`. Frames whose `file` we
 * can't match against any uploaded sourcemap are returned unchanged.
 *
 * Returns the stack with each frame either translated (if a map was found)
 * or pass-through (if not). The caller chooses how to surface translated vs
 * original to the agent.
 */
export async function translateStack(
  env: Env,
  projectId: string,
  releaseId: string | null | undefined,
  stack: StackFrame[],
): Promise<TranslatedStackFrame[]> {
  if (!stack.length) return stack as TranslatedStackFrame[];
  if (!env.SOURCEMAPS) return stack as TranslatedStackFrame[];

  // Collect unique source URLs across frames. Skip frames without a file
  // (synthesized stacks) — nothing to translate.
  const wantedSources = new Set<string>();
  for (const f of stack) {
    const src = normalizeSourceUrl(f.file);
    if (src) wantedSources.add(src);
  }
  if (wantedSources.size === 0) return stack as TranslatedStackFrame[];

  // Look up which of those sources we have sourcemaps for under this release.
  const db = getDb(env);
  const candidates = await loadSourcemapIndex(
    db,
    projectId,
    releaseId,
    [...wantedSources],
  );

  if (candidates.size === 0) return stack as TranslatedStackFrame[];

  const mapCache: LoadedMapCache = new Map();

  // Translate each frame in series. CF Workers don't have native parallelism
  // for R2 .get() any meaningful way (it's all promises on the same event
  // loop), but we still get pipelining via Promise.all if we batch — keep
  // it serial for clarity; sourcemap counts per case are typically 1–5.
  const out: TranslatedStackFrame[] = [];
  for (const frame of stack) {
    const src = normalizeSourceUrl(frame.file);
    if (!src || !candidates.has(src)) {
      out.push({ ...frame, unmangled: false });
      continue;
    }
    if (frame.line === undefined || frame.line === null) {
      out.push({ ...frame, unmangled: false });
      continue;
    }
    const map = await ensureMapLoaded(env, mapCache, src, candidates.get(src)!);
    if (!map) {
      out.push({ ...frame, unmangled: false });
      continue;
    }
    const original = originalPositionFor(map, {
      line: frame.line,
      column: frame.column ?? 0,
    });
    if (original.source === null) {
      out.push({ ...frame, unmangled: false });
      continue;
    }
    out.push({
      ...frame,
      original_file: original.source,
      original_line: original.line ?? undefined,
      original_column: original.column ?? undefined,
      original_name: original.name ?? undefined,
      unmangled: true,
    });
  }

  return out;
}

/** Normalize whatever's in the stack `file` field into a canonical lookup key.
 *
 * Stack traces from browsers include absolute URLs like
 * `https://cdn.app.com/static/chunks/abc.js?v=1.2`. We strip the protocol,
 * host, and query string so uploads keyed by pathname (the common case)
 * match. Falls back to the raw string for non-URL files. */
function normalizeSourceUrl(file: string | undefined | null): string | null {
  if (!file) return null;
  try {
    const u = new URL(file);
    return u.pathname; // discard host + search + hash
  } catch {
    // Not a URL — already a path. Strip any query/hash defensively.
    return file.replace(/[?#].*$/, "");
  }
}

interface SourcemapRow {
  releaseId: string;
  sourceUrl: string;
  r2Key: string;
}

/** Returns map[source_url → row] for any sourcemap rows matching the requested
 * sources under `releaseId` (falling back to `"default"` if releaseId is null
 * or no match found for the specific release). */
async function loadSourcemapIndex(
  db: ReturnType<typeof getDb>,
  projectId: string,
  releaseId: string | null | undefined,
  sources: string[],
): Promise<Map<string, SourcemapRow>> {
  // Look up rows for either the specific release OR the "default" fallback.
  const releaseCandidates = releaseId && releaseId !== "unknown"
    ? [releaseId, "default"]
    : ["default"];
  const rows = await db
    .select({
      releaseId: sourcemaps.releaseId,
      sourceUrl: sourcemaps.sourceUrl,
      r2Key: sourcemaps.r2Key,
    })
    .from(sourcemaps)
    .where(
      and(
        eq(sourcemaps.projectId, projectId),
        inArray(sourcemaps.releaseId, releaseCandidates),
        inArray(sourcemaps.sourceUrl, sources),
      ),
    );
  // Prefer specific releaseId over "default" if both exist.
  const idx = new Map<string, SourcemapRow>();
  for (const r of rows) {
    const existing = idx.get(r.sourceUrl);
    if (!existing || (existing.releaseId === "default" && r.releaseId !== "default")) {
      idx.set(r.sourceUrl, r);
    }
  }
  return idx;
}

async function ensureMapLoaded(
  env: Env,
  cache: LoadedMapCache,
  sourceUrl: string,
  row: SourcemapRow,
): Promise<TraceMap | null> {
  if (cache.has(sourceUrl)) return cache.get(sourceUrl)!;
  if (!env.SOURCEMAPS) {
    cache.set(sourceUrl, null);
    return null;
  }
  const obj = await env.SOURCEMAPS.get(row.r2Key);
  if (!obj) {
    cache.set(sourceUrl, null);
    return null;
  }
  try {
    const text = await obj.text();
    const map = new TraceMap(JSON.parse(text));
    cache.set(sourceUrl, map);
    return map;
  } catch {
    cache.set(sourceUrl, null);
    return null;
  }
}
