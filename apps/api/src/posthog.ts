// PostHog integration — per-user teams via admin sidecar (the ironclad model).
//
// Design (2026-05-15 final, supersedes the shared-project + groups model):
//
//   - Each agentry user gets THEIR OWN PostHog team_id, created via direct
//     INSERT into PostHog's Postgres through a small admin sidecar service
//     running alongside PostHog on the Hetzner VPS. The sidecar bypasses the
//     PostHog OSS project-quota gate without touching any other isolation
//     mechanism.
//   - With per-user team_ids in place, PostHog's HogQL compiler enforces
//     `WHERE events.team_id = <forced>` at the AST level on every query.
//     Same isolation Enterprise customers get — no application-layer regex,
//     no blocklist, no string injection. The user's HogQL can include UNION,
//     CTEs, subqueries, comments, anything — team_id is wrapped around every
//     `events` reference by PostHog's own query compiler.
//
//   - The `posthog_projects` table indexes per-user teams:
//       posthog_project_id    → PostHog team_id (used in /api/projects/:id/ URL)
//       posthog_project_api_key → team's write key (phc_…) for /capture/
//       posthog_host          → POSTHOG_HOST
//
//   - read_token_enc / read_token_iv are LEGACY (used by the old design that
//     stored per-user master keys). Kept on the row for back-compat; the
//     master key now lives in POSTHOG_MASTER_API_KEY env and applies to all
//     query traffic. Per-user team_id is what isolates reads.
//
// Required env (all secrets, set via `wrangler secret put`):
//   POSTHOG_HOST                 e.g. https://posthog.agentry.sh
//   POSTHOG_MASTER_API_KEY       Personal API Key (phx_…), used as Bearer
//                                for all HogQL queries. Org-wide read; per-
//                                user isolation lives in the team_id on the
//                                project endpoint URL.
//   POSTHOG_ORG_ID               UUID — the org the admin sidecar creates
//                                teams under.
//   AGENTRY_ADMIN_URL            e.g. https://posthog.agentry.sh/agentry-admin
//   AGENTRY_ADMIN_TOKEN          Bearer for the admin sidecar's
//                                /provision-team endpoint.
//   AGENTRY_TOKEN_ENC_KEY        32-byte base64url AES-256 key (used by
//                                webhooks.ts and legacy posthog_projects rows).

import { errors, base64url, fromBase64url } from "@agentrysh/shared";
import { posthogProjects } from "@agentry/db/schema";
import type { Env } from "./env.js";
import { getDb } from "./db.js";
import { eq } from "drizzle-orm";

const POSTHOG_TIMEOUT_MS = 10_000;

export function isPosthogConfigured(env: Env): boolean {
  return Boolean(
    env.POSTHOG_HOST &&
      env.POSTHOG_MASTER_API_KEY &&
      env.AGENTRY_ADMIN_URL &&
      env.AGENTRY_ADMIN_TOKEN,
  );
}

// ---------------------------------------------------------------------------
// AES-GCM helpers — used by webhooks.ts (encrypting webhook signing secrets).
// ---------------------------------------------------------------------------

async function importKey(rawBase64Url: string): Promise<CryptoKey> {
  const raw = fromBase64url(rawBase64Url);
  if (raw.byteLength !== 32) {
    throw errors.internal(
      `AGENTRY_TOKEN_ENC_KEY must be 32 bytes base64url, got ${raw.byteLength}.`,
    );
  }
  return globalThis.crypto.subtle.importKey(
    "raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"],
  );
}

export async function encryptToken(
  env: Env,
  plaintext: string,
): Promise<{ enc: string; iv: string }> {
  if (!env.AGENTRY_TOKEN_ENC_KEY) throw errors.internal("AGENTRY_TOKEN_ENC_KEY missing.");
  const key = await importKey(env.AGENTRY_TOKEN_ENC_KEY);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext),
  );
  return { enc: base64url(new Uint8Array(ct)), iv: base64url(iv) };
}

export async function decryptToken(
  env: Env,
  enc: string,
  iv: string,
): Promise<string> {
  if (!env.AGENTRY_TOKEN_ENC_KEY) throw errors.internal("AGENTRY_TOKEN_ENC_KEY missing.");
  const key = await importKey(env.AGENTRY_TOKEN_ENC_KEY);
  const ct = fromBase64url(enc);
  const ivBytes = fromBase64url(iv);
  const pt = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes }, key, ct,
  );
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function host(env: Env): string {
  return env.POSTHOG_HOST!.replace(/\/$/, "");
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`posthog timeout after ${ms}ms`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Admin sidecar — provisions per-user PostHog teams via direct Postgres INSERT.
// Bypasses PostHog OSS's per-org project quota without forking the project.
// See /home/henrikh/agentry-admin on the Hetzner VPS.
// ---------------------------------------------------------------------------

interface ProvisionResponse {
  team_id: number;
  project_id: number;
  api_token: string;
  agentry_user_id: string;
}

async function provisionTeamForUser(
  env: Env,
  agentryUserId: string,
  name: string,
): Promise<ProvisionResponse> {
  const url = `${env.AGENTRY_ADMIN_URL!.replace(/\/$/, "")}/provision-team`;
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.AGENTRY_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        name: name.slice(0, 80).replace(/[^A-Za-z0-9._-]/g, "-"),
        agentry_user_id: agentryUserId,
      }),
    }),
    POSTHOG_TIMEOUT_MS,
  );
  if (!res.ok) {
    const body = await res.text();
    throw errors.internal(
      `agentry-admin /provision-team ${res.status}: ${body.slice(0, 400)}`,
    );
  }
  return (await res.json()) as ProvisionResponse;
}

// ---------------------------------------------------------------------------
// Per-user team lookup + persistence.
// ---------------------------------------------------------------------------

export async function getPosthogProjectForUser(env: Env, userId: string) {
  const db = getDb(env);
  const rows = await db
    .select()
    .from(posthogProjects)
    .where(eq(posthogProjects.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

async function persistPosthogTeam(
  env: Env,
  userId: string,
  team: { team_id: number; api_token: string },
): Promise<void> {
  // Legacy schema requires read_token_enc + read_token_iv (the old design
  // stored per-user master keys). We no longer use those — encrypt a dummy
  // value to satisfy the NOT NULL constraint. Future migration: relax the
  // columns to nullable.
  const enc = await encryptToken(env, "LEGACY_UNUSED");
  const db = getDb(env);
  await db.insert(posthogProjects).values({
    userId,
    posthogProjectId: team.team_id,
    posthogProjectApiKey: team.api_token,
    readTokenEnc: enc.enc,
    readTokenIv: enc.iv,
    posthogHost: host(env),
    createdAt: Math.floor(Date.now() / 1000),
  });
}

export async function ensurePosthogForUser(
  env: Env,
  userId: string,
  githubUsername: string,
): Promise<{ provisioned: boolean; posthogProjectId: number | null }> {
  if (!isPosthogConfigured(env)) {
    return { provisioned: false, posthogProjectId: null };
  }
  const existing = await getPosthogProjectForUser(env, userId);
  if (existing) {
    return { provisioned: false, posthogProjectId: existing.posthogProjectId };
  }
  const team = await provisionTeamForUser(
    env,
    userId,
    `agentry-user-${githubUsername || userId.slice(0, 8)}`,
  );
  await persistPosthogTeam(env, userId, { team_id: team.team_id, api_token: team.api_token });
  return { provisioned: true, posthogProjectId: team.team_id };
}

// ---------------------------------------------------------------------------
// Capture: per-user team api_token forwards to PostHog's /capture/.
// PostHog stamps team_id from the api_token, so isolation begins at ingest.
// ---------------------------------------------------------------------------

export async function forwardCapture(
  env: Env,
  userId: string,
  body: {
    event: string;
    distinct_id?: string;
    properties?: Record<string, unknown>;
    timestamp?: number;
  },
): Promise<{ status: number; reason?: string }> {
  if (!isPosthogConfigured(env)) {
    return { status: 503, reason: "agentry deployment has no PostHog configured" };
  }
  const ph = await getPosthogProjectForUser(env, userId);
  if (!ph) {
    return { status: 503, reason: "user has no PostHog project provisioned" };
  }

  const payload = {
    api_key: ph.posthogProjectApiKey,
    event: body.event,
    distinct_id:
      body.distinct_id ??
      (body.properties?.["$user_id"] as string | undefined) ??
      "anonymous",
    properties: body.properties ?? {},
    timestamp:
      typeof body.timestamp === "number"
        ? new Date(body.timestamp * 1000).toISOString()
        : undefined,
  };

  const res = await withTimeout(
    fetch(`${ph.posthogHost.replace(/\/$/, "")}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    POSTHOG_TIMEOUT_MS,
  );
  if (!res.ok) {
    return { status: res.status, reason: await res.text().then((t) => t.slice(0, 200)) };
  }
  return { status: 200 };
}

// ---------------------------------------------------------------------------
// HogQL passthrough. The per-user team_id is in the URL — PostHog's HogQL
// compiler hardcodes `WHERE events.team_id = <team>` into every generated
// ClickHouse query, AST-level. Cross-user isolation is structural; no regex,
// no blocklist, no string rewriting. UNION/CTE/subquery/comments — all safe
// because PostHog wraps team_id around every `events` reference itself.
// ---------------------------------------------------------------------------

export interface RunHogQlOpts {
  /** Reserved for future per-call options. trusted/wrap flags removed —
   *  isolation is enforced by PostHog at the AST level via team_id. */
  _reserved?: never;
}

export async function runHogQl(
  env: Env,
  userId: string,
  query: string,
  _opts: RunHogQlOpts = {},
): Promise<{ results: unknown[]; columns: string[] | null; types: string[] | null }> {
  if (!isPosthogConfigured(env)) throw errors.internal("posthog not configured");
  const ph = await getPosthogProjectForUser(env, userId);
  if (!ph) throw errors.notFound("posthog_project");

  const url = `${host(env)}/api/projects/${ph.posthogProjectId}/query/`;
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.POSTHOG_MASTER_API_KEY}`,
      },
      body: JSON.stringify({
        query: { kind: "HogQLQuery", query },
      }),
    }),
    POSTHOG_TIMEOUT_MS,
  );
  const text = await res.text();
  if (!res.ok) {
    throw errors.internal(`PostHog query ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = JSON.parse(text) as {
    results?: unknown[];
    columns?: string[];
    types?: string[];
  };
  return {
    results: json.results ?? [],
    columns: json.columns ?? null,
    types: json.types ?? null,
  };
}
