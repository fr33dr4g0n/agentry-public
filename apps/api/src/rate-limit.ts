// In-isolate token-bucket rate limit for the public-query endpoint.
//
// Why in-isolate: Cloudflare Workers globals live for the colo's isolate
// lifetime (minutes-to-hours). That's enough to break an attacker's loop
// pattern from a single source IP without adding KV/DO bindings or DB
// writes per request. Distributed-coordinated rate limit isn't worth the
// complexity for the threat model — the worst case (attacker rotates
// across colos) still leaves them spreading load across our infra, which
// is exactly what the limit is meant to absorb.
//
// Key per (publication_id, ip). Bucket: 60 requests / 60s.
// Returns 429 with Retry-After header when exceeded.

import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings } from "./env.js";

interface Bucket {
  /** Tokens currently available. */
  tokens: number;
  /** Unix millis of last refill. */
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

// Tunables. Conservative — public-dashboard pages should refresh on
// human-scale cadence (1-10s), not in a tight loop.
const CAPACITY = 60;
const REFILL_PER_SEC = 1; // 60/min → 1/s
const WINDOW_LIMIT_MS = 60_000;

// Garbage collection: drop buckets idle > 10 minutes.
const GC_INTERVAL_MS = 60_000;
let lastGc = 0;

function gcStaleBuckets(now: number): void {
  if (now - lastGc < GC_INTERVAL_MS) return;
  lastGc = now;
  for (const [k, b] of buckets.entries()) {
    if (now - b.lastRefill > 10 * 60_000) buckets.delete(k);
  }
}

function takeOne(key: string, now: number): { allowed: boolean; retryAfterSec: number } {
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: CAPACITY - 1, lastRefill: now };
    buckets.set(key, b);
    return { allowed: true, retryAfterSec: 0 };
  }
  // Refill based on elapsed time.
  const elapsedSec = Math.max(0, (now - b.lastRefill) / 1000);
  b.tokens = Math.min(CAPACITY, b.tokens + elapsedSec * REFILL_PER_SEC);
  b.lastRefill = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, retryAfterSec: 0 };
  }
  // Empty bucket: tell the client how long until ≥1 token.
  const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / REFILL_PER_SEC));
  return { allowed: false, retryAfterSec };
}

function clientIp(c: Context<AppBindings>): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-real-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/** Per-(publication_id, ip) token bucket. Use as Hono middleware on
 *  /v1/public/q/*. Falls through on success; 429s on bucket-empty. */
export function publicQueryRateLimit(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const now = Date.now();
    gcStaleBuckets(now);
    // Path looks like /v1/public/q/<publication_id>; extract the segment.
    const path = new URL(c.req.url).pathname;
    const seg = path.split("/v1/public/q/")[1] ?? "";
    const publicationId = seg.split("/")[0] ?? "unknown";
    const key = `${publicationId}:${clientIp(c)}`;
    const r = takeOne(key, now);
    if (!r.allowed) {
      c.header("Retry-After", String(r.retryAfterSec));
      return c.json(
        {
          error: {
            code: "rate_limited",
            message:
              `Too many requests for this publication from your IP. ${CAPACITY}/min limit.`,
            next_action:
              "Slow your refresh rate. Public dashboards should refresh on human-scale " +
              "cadence (every few seconds at fastest), not in a tight loop. " +
              "If you're hitting this from a legitimate high-traffic page, cache the result " +
              "in your edge / CDN and serve from there.",
          },
        },
        429,
      );
    }
    return await next();
  };
}

/** Test helper — clears all buckets. Not exported via package barrel. */
export function __clearRateLimitForTests(): void {
  buckets.clear();
  lastGc = 0;
}
