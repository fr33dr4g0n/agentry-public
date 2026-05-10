// Webhook subscription + signed delivery.
//
// Each project can register URLs that get a signed POST when:
//   - case.created       — a new error fingerprint surfaces
//   - case.resolved      — a case status flips to "resolved"
//   - deploy.recorded    — a deploy event is captured
//
// Delivery is fire-and-forget (no retries in v0). The customer's endpoint is
// expected to enqueue a job and return 2xx. We update last_fired_at /
// last_status / last_error so the customer's agent can `agentry_list_webhooks`
// and see what happened.
//
// Signing: HMAC-SHA256(body, signing_secret) → header
//   X-Agentry-Signature: t=<unix>,v1=<hex>
// The customer recomputes the same hash with their stored signing_secret and
// compares with constant-time equality. If mismatch, reject the request.

import { eq, sql } from "drizzle-orm";
import { base64url, sha256Hex, uuidv7 } from "@agentry/shared";
import { webhooks, type Webhook } from "@agentry/db/schema";
import type { Env } from "./env.js";
import { getDb } from "./db.js";

export type WebhookEvent = "case.created" | "case.resolved" | "deploy.recorded";

export const ALL_EVENTS: WebhookEvent[] = ["case.created", "case.resolved", "deploy.recorded"];

const DELIVERY_TIMEOUT_MS = 5_000;

export interface MintedSecret {
  raw: string;
  prefix: string;
  hash: string;
}

export async function mintSigningSecret(): Promise<MintedSecret> {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const tail = base64url(bytes);
  const raw = `whsec_${tail}`;
  const hash = await sha256Hex(raw);
  return { raw, prefix: raw.slice(0, 12), hash };
}

// HMAC-SHA256(body, secret) → hex
export async function signBody(body: string, secret: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface DeliverOptions {
  webhook: Webhook;
  body: string;       // pre-serialized; we sign exactly what we send
  secretRaw: string;  // unhashed; only available right after creation
}

async function deliverOne(env: Env, opts: DeliverOptions): Promise<void> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signBody(opts.body, opts.secretRaw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  let status = 0;
  let errMessage: string | null = null;
  try {
    const res = await fetch(opts.webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "agentry-webhook/0",
        "x-agentry-signature": `t=${ts},v1=${sig}`,
        "x-agentry-event": new (URL as unknown as new (s: string) => URL)(opts.webhook.url).host,
        "x-agentry-webhook-id": opts.webhook.id,
      },
      body: opts.body,
      signal: controller.signal,
    });
    status = res.status;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      errMessage = `non-2xx ${res.status}: ${text.slice(0, 300)}`;
    }
  } catch (err) {
    errMessage = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  // Update last-status fields. Best-effort; never throws.
  try {
    const db = getDb(env);
    await db
      .update(webhooks)
      .set({ lastFiredAt: ts, lastStatus: status, lastError: errMessage })
      .where(eq(webhooks.id, opts.webhook.id));
  } catch {
    // ignore — telemetry write failure shouldn't impact the main request
  }
}

// ⚠ The hard part: at firing time we no longer have the unhashed signing secret.
// Workaround for v0: when a webhook is registered, we ALSO store a "delivery key"
// derived from the secret (KDF) — but actually the simpler approach is to let the
// signature use the SECRET HASH itself. The customer can't recompute it that way
// without the hash, which they don't see.
//
// Cleanest fix: store the secret encrypted with AGENTRY_TOKEN_ENC_KEY (same key
// used for PostHog tokens) so we can decrypt at firing time. We keep the public
// SHA-256 prefix for display and do strict-eq on auth, but symmetric-encrypt the
// raw value for outbound HMAC use.

import { decryptToken, encryptToken } from "./posthog.js";

export async function persistWebhook(
  env: Env,
  input: {
    id: string;
    projectId: string;
    url: string;
    description: string | null;
    events: WebhookEvent[];
    secret: MintedSecret;
  },
): Promise<void> {
  // Encrypt the raw secret for later HMAC use. Store BOTH: hash (for display
  // verification / lookups) and ciphertext (for outbound signing).
  const enc = await encryptToken(env, input.secret.raw);
  const db = getDb(env);
  await db.insert(webhooks).values({
    id: input.id,
    projectId: input.projectId,
    url: input.url,
    description: input.description,
    events: JSON.stringify(input.events),
    signingSecretPrefix: input.secret.prefix,
    signingSecretHash: input.secret.hash,
    // Stash the encrypted ciphertext + iv inside last_error column? No — clean it up.
    // Use signing_secret_hash to hold "<hash>:<iv>:<ct>" — concatenated string.
    // For a real prod schema we'd add ciphertext + iv columns; v0 packs them.
    createdAt: Math.floor(Date.now() / 1000),
    active: 1,
  });
  // Store packed ciphertext separately keyed on the same row (we extend
  // signing_secret_hash by appending a separator). Simpler: we put it in
  // lastError just to pack into existing schema, but that's gross. Instead,
  // we'll abuse signing_secret_hash to hold "<hash>::<iv>::<enc>" — three
  // segments separated by "::". The hash stays first so the verify path
  // doesn't need to change.
  const packed = `${input.secret.hash}::${enc.iv}::${enc.enc}`;
  await db
    .update(webhooks)
    .set({ signingSecretHash: packed })
    .where(eq(webhooks.id, input.id));
}

async function recoverSigningSecret(env: Env, hookRow: Webhook): Promise<string | null> {
  const parts = hookRow.signingSecretHash.split("::");
  if (parts.length !== 3) return null;
  const [, iv, ct] = parts;
  if (!iv || !ct) return null;
  try {
    return await decryptToken(env, ct, iv);
  } catch {
    return null;
  }
}

export interface FireOptions {
  /** ExecutionContext.waitUntil so delivery happens after the response. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** When true, fire even for inactive webhooks (used by the test endpoint). */
  ignoreActive?: boolean;
  /** Only fire to this specific webhook id (used by the test endpoint). */
  webhookId?: string;
}

export async function fireWebhooks(
  env: Env,
  projectId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  opts: FireOptions = {},
): Promise<void> {
  const db = getDb(env);

  const where = opts.webhookId
    ? eq(webhooks.id, opts.webhookId)
    : opts.ignoreActive
    ? eq(webhooks.projectId, projectId)
    : sql`${webhooks.projectId} = ${projectId} AND ${webhooks.active} = 1`;

  const rows = await db.select().from(webhooks).where(where);
  if (rows.length === 0) return;

  const payload = JSON.stringify({
    event,
    delivered_at: Math.floor(Date.now() / 1000),
    project_id: projectId,
    data,
  });

  const tasks: Array<Promise<void>> = [];
  for (const w of rows) {
    if (!opts.webhookId) {
      // Filter on subscribed events
      try {
        const events = JSON.parse(w.events) as string[];
        if (!events.includes(event)) continue;
      } catch {
        continue;
      }
    }
    const secret = await recoverSigningSecret(env, w);
    if (!secret) continue;
    tasks.push(deliverOne(env, { webhook: w, body: payload, secretRaw: secret }));
  }

  const all = Promise.allSettled(tasks);
  if (opts.waitUntil) opts.waitUntil(all);
  else await all;
}
