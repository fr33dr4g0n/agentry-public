// Multi-tenant PostHog provisioning + encryption helpers.
//
// Design:
//   - One self-hosted PostHog instance owned by agentry.
//   - Each agentry user gets exactly one PostHog project (PostHog's native
//     isolation unit) — auto-provisioned on first GitHub OAuth completion.
//   - The PostHog project's write key (api_token) is stored as plaintext —
//     it grants `/capture` access only and is non-confidential.
//   - The PostHog Personal API Key (read scope) is encrypted at rest with
//     AES-GCM using AGENTRY_TOKEN_ENC_KEY.
//
// All HTTP to PostHog uses fetch with explicit timeouts.

import { errors, base64url, fromBase64url } from "@agentry/shared";
import { posthogProjects } from "@agentry/db/schema";
import type { Env } from "./env.js";
import { getDb } from "./db.js";
import { eq } from "drizzle-orm";

const PROVISION_TIMEOUT_MS = 10_000;

export function isPosthogConfigured(env: Env): boolean {
  return Boolean(
    env.POSTHOG_HOST &&
      env.POSTHOG_ORG_ID &&
      env.POSTHOG_MASTER_API_KEY &&
      env.AGENTRY_TOKEN_ENC_KEY,
  );
}

// ---------------------------------------------------------------------------
// AES-GCM encryption for PostHog read tokens.
// AGENTRY_TOKEN_ENC_KEY must be a 32-byte (256-bit) key, base64url-encoded.
// ---------------------------------------------------------------------------

async function importKey(rawBase64Url: string): Promise<CryptoKey> {
  const raw = fromBase64url(rawBase64Url);
  if (raw.byteLength !== 32) {
    throw errors.internal(
      `AGENTRY_TOKEN_ENC_KEY must be 32 bytes base64url, got ${raw.byteLength}.`,
    );
  }
  return globalThis.crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
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
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
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
    { name: "AES-GCM", iv: ivBytes },
    key,
    ct,
  );
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------------------
// PostHog API proxies.
// ---------------------------------------------------------------------------

interface PosthogProjectResponse {
  id: number;
  api_token: string;
  name?: string;
}

interface PosthogPersonalKeyResponse {
  id: number | string;
  value: string;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`posthog timeout after ${ms}ms`)), ms),
    ),
  ]);
}

async function postJson<T>(
  url: string,
  body: unknown,
  bearerToken: string,
): Promise<T> {
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(body),
    }),
    PROVISION_TIMEOUT_MS,
  );
  const text = await res.text();
  if (!res.ok) {
    throw errors.internal(`PostHog ${res.status} on ${url}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}

export async function createPosthogProject(env: Env, name: string): Promise<{
  posthogProjectId: number;
  writeApiKey: string;
  readToken: string;
}> {
  if (!env.POSTHOG_HOST) throw errors.internal("POSTHOG_HOST missing.");
  const host = env.POSTHOG_HOST.replace(/\/$/, "");
  const orgId = env.POSTHOG_ORG_ID!;
  const masterKey = env.POSTHOG_MASTER_API_KEY!;

  // 1. Create the project under the agentry org.
  const proj = await postJson<PosthogProjectResponse>(
    `${host}/api/organizations/${encodeURIComponent(orgId)}/projects/`,
    { name },
    masterKey,
  );

  // 2. Mint a project-scoped Personal API Key for read queries.
  //    Scoping to a single project means a leak only affects that one customer.
  const personalKey = await postJson<PosthogPersonalKeyResponse>(
    `${host}/api/personal_api_keys/`,
    {
      label: `agentry-readonly-project-${proj.id}`,
      scopes: ["query:read", "insight:read", "feature_flag:read"],
      scoped_teams: [proj.id],
    },
    masterKey,
  );

  return {
    posthogProjectId: proj.id,
    writeApiKey: proj.api_token,
    readToken: personalKey.value,
  };
}

export async function getPosthogProjectForUser(env: Env, userId: string) {
  const db = getDb(env);
  const rows = await db
    .select()
    .from(posthogProjects)
    .where(eq(posthogProjects.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function persistPosthogProject(
  env: Env,
  userId: string,
  ph: { posthogProjectId: number; writeApiKey: string; readToken: string },
) {
  const enc = await encryptToken(env, ph.readToken);
  const db = getDb(env);
  await db.insert(posthogProjects).values({
    userId,
    posthogProjectId: ph.posthogProjectId,
    posthogProjectApiKey: ph.writeApiKey,
    readTokenEnc: enc.enc,
    readTokenIv: enc.iv,
    posthogHost: env.POSTHOG_HOST!,
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
  if (existing) return { provisioned: false, posthogProjectId: existing.posthogProjectId };

  const created = await createPosthogProject(env, `agentry-user-${githubUsername}`);
  await persistPosthogProject(env, userId, created);
  return { provisioned: true, posthogProjectId: created.posthogProjectId };
}

// ---------------------------------------------------------------------------
// Capture proxy: forwards events from agentry's /v1/track to the user's PostHog.
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
  const ph = await getPosthogProjectForUser(env, userId);
  if (!ph) return { status: 503, reason: "user has no PostHog project provisioned" };

  const payload = {
    api_key: ph.posthogProjectApiKey,
    event: body.event,
    distinct_id:
      body.distinct_id ?? (body.properties?.["$user_id"] as string | undefined) ?? "anonymous",
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
    PROVISION_TIMEOUT_MS,
  );
  if (!res.ok) {
    return { status: res.status, reason: await res.text().then((t) => t.slice(0, 200)) };
  }
  return { status: 200 };
}

// ---------------------------------------------------------------------------
// HogQL passthrough for the agent's funnel/event queries.
// ---------------------------------------------------------------------------

export async function runHogQl(
  env: Env,
  userId: string,
  query: string,
): Promise<{ results: unknown[]; columns: string[] | null; types: string[] | null }> {
  const ph = await getPosthogProjectForUser(env, userId);
  if (!ph) throw errors.notFound("posthog_project");
  const readToken = await decryptToken(env, ph.readTokenEnc, ph.readTokenIv);

  const url = `${ph.posthogHost.replace(/\/$/, "")}/api/projects/${ph.posthogProjectId}/query/`;
  const body = {
    query: { kind: "HogQLQuery", query },
  };
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${readToken}`,
      },
      body: JSON.stringify(body),
    }),
    PROVISION_TIMEOUT_MS,
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
