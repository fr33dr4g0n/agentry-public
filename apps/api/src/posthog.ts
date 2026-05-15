// PostHog integration — shared-project + groups model.
//
// Design (post-2026-05-15 refactor, see docs/decisions.md):
//   - ONE PostHog project across all agentry users. PostHog self-hosted OSS
//     caps the org at 1 project, and project-per-user doesn't scale anyway.
//   - Each agentry user is a PostHog GROUP (group_type = "agentry_user",
//     group_key = the agentry user's uuid). Events ingested via /v1/track/
//     get `$groups: { agentry_user: <userId> }` injected so PostHog tags them
//     to that user's group.
//   - HogQL queries are sent with a `filters.properties` array that
//     constrains every query to the user's group_key — even if the user's
//     raw SQL doesn't include a WHERE clause for it. PostHog applies the
//     filter at the query-planning layer, so there's no way for one user's
//     query to read another user's events.
//
// Required env (all secrets, set via `wrangler secret put`):
//   POSTHOG_HOST              e.g. https://posthog.agentry.sh
//   POSTHOG_PROJECT_ID        integer — the shared project id (the "Default
//                             project", id=1, in a default PostHog install)
//   POSTHOG_PROJECT_API_KEY   the project's write key (phc_…), used as the
//                             `api_key` field on /capture/ calls. Public-ish.
//   POSTHOG_MASTER_API_KEY    Personal API Key (phx_…), used as Bearer for
//                             HogQL queries against /api/projects/:id/query/.
//                             ORG-WIDE read; query-level group filter ensures
//                             per-user isolation.
//   AGENTRY_TOKEN_ENC_KEY     legacy — kept for webhook-secret encryption
//                             (see webhooks.ts) and back-compat with any
//                             legacy posthog_projects rows.
//
// Legacy env (no longer required, kept readable for back-compat):
//   POSTHOG_ORG_ID            used by the old createPosthogProject path

import { errors, base64url, fromBase64url } from "@agentrysh/shared";
import { posthogProjects } from "@agentry/db/schema";
import type { Env } from "./env.js";
import { getDb } from "./db.js";
import { eq } from "drizzle-orm";

const PROVISION_TIMEOUT_MS = 10_000;

// The group type key used for partitioning agentry users in PostHog.
// PostHog auto-registers group types on first use. Don't rename — existing
// events would orphan.
const AGENTRY_USER_GROUP_TYPE = "agentry_user";

// HogQL the agent can't write. Rejecting these closes the demonstrated
// bypasses of injectGroupFilter (SQL comments, UNION, CTEs, multi-table-ref
// subqueries, and references to PostHog tables we don't filter).
//
// This is a BLOCKLIST not a parser — string-level. It's defense-in-depth on
// top of the WHERE-clause injection. The real long-term fix is either (a) a
// PostHog Enterprise license + PostHog-native team_id isolation per agentry
// user, or (b) a sidecar that injects ClickHouse session settings to drive
// row policies. See docs/decisions.md.
//
// What's allowed: SELECT … FROM events [WHERE …] [GROUP BY …] [ORDER BY …]
//                 [LIMIT …] [HAVING …] — single SELECT, single FROM events
//                 reference, no comments, no other tables.
//
// What's rejected: anything that could let an attacker scan unfiltered data.
// Blocklist for user-supplied (untrusted) HogQL. The wrap technique handles
// UNION / CTEs / subqueries, so we only need to forbid patterns that could
// confuse the wrap regex or access unfiltered tables.
//
// Recipes (server-controlled HogQL, `trusted: true`) skip this entirely —
// they're safe by construction, and the wrap still applies to their events
// references for the same isolation guarantee.
const HOGQL_BLOCKLIST: Array<{ name: string; matcher: RegExp; reason: string }> = [
  // SQL comments — could shift our regex matches in unexpected ways.
  // Easier to ban than to parse around.
  { name: "line comment", matcher: /--/, reason: "SQL line comments (`--`) are not allowed in user-supplied HogQL. Remove the comment and retry." },
  { name: "block comment", matcher: /\/\*|\*\//, reason: "SQL block comments (`/* */`) are not allowed in user-supplied HogQL." },
  // Only `events` is queryable from untrusted HogQL. Other PostHog tables
  // (persons, groups, sessions, session_replay_events, cohort_people,
  // system.*, etc.) aren't isolated per agentry user.
  //
  // The wrap turns every `FROM events` / `JOIN events` into a subquery, so
  // after wrap, the query contains `FROM (SELECT * FROM events WHERE …)`.
  // We must allow `FROM (` (subqueries) and `JOIN (`, but reject `FROM <other_table>`.
  // We validate BEFORE wrap, so the user query at this point only has bare
  // table references — making "no non-events table" easy to check.
  {
    name: "non-events FROM/JOIN",
    matcher: /\b(?:FROM|JOIN)\s+(?!events\b)(?!\()(?!\s*\(\s*SELECT\b)[A-Za-z_][\w.]*/i,
    reason:
      "Only the `events` table is queryable. References to persons, groups, sessions, " +
      "session_replay_events, cohort_people, system.*, etc. are blocked because they're " +
      "not currently scoped per agentry user. Use a recipe (agentry_list_recipes) for queries " +
      "that need those — recipes use server-controlled HogQL that's safely written.",
  },
];

function validateHogQl(hogql: string): void {
  for (const rule of HOGQL_BLOCKLIST) {
    if (rule.matcher.test(hogql)) {
      throw errors.invalidPayload({
        reason: rule.reason,
        rejected_pattern: rule.name,
      });
    }
  }
  // Must reference events at least once — pure utility queries like
  // `SELECT now()` don't make sense in this API.
  if (!/\bFROM\s+events\b/i.test(hogql)) {
    throw errors.invalidPayload({
      reason:
        "HogQL queries must include `FROM events`. Other PostHog tables (persons, groups, " +
        "sessions) aren't isolated per agentry user. Use a recipe (agentry_list_recipes) if " +
        "you need to join those.",
      rejected_pattern: "no FROM events",
    });
  }
}

// Wrap every `FROM events` (and `JOIN events`) reference in user-supplied
// HogQL with a per-user-filtered subquery, so cross-user isolation is
// enforced at the table-reference layer — not the outer WHERE clause.
//
// Why this shape: PostHog's `filters.properties` block in the query API is
// silently dropped (proven by inspecting generated ClickHouse SQL). Outer-
// WHERE injection works for SELECT…FROM events but breaks on UNION,
// subqueries, CTEs, and other multi-SELECT shapes. Wrapping every events
// reference is the only injection-style approach that handles them.
//
// Each `events` → `(SELECT * FROM events WHERE properties.$group_0 = '<uid>')`
// substitution preserves the alias, if any.
//
// The userId is a v7 UUID validated by injectGroupFilter's caller (and re-
// checked here). Embedding it as a SQL literal is injection-safe.
//
// Limitations:
//   - Inline string literals containing "FROM events" would be rewritten.
//     We accept this — agents almost never put SQL keywords in event names.
//   - `events_*` table variants (PostHog has none of these as user-queryable
//     today) would NOT be rewritten. The blocklist disallows referencing
//     anything other than `events` in untrusted queries, closing this gap.
function wrapEventsTable(hogql: string, userId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new Error("wrapEventsTable requires a UUID userId");
  }
  const filtered = `(SELECT * FROM events WHERE properties.$group_0 = '${userId}')`;
  // Match `FROM events` or `JOIN events` (case-insensitive), with optional
  // alias following (single word, optionally preceded by AS). Replace with
  // the filtered subquery; preserve the alias on the wrapped subquery.
  // Skip the rewrite if we're already inside a filtered subquery (i.e. the
  // events ref is the one we just wrote). We detect this by ensuring the
  // preceding char isn't a `(` (which would mean we're recursing). Simple
  // approach: do a single pass with a non-greedy regex.
  //
  // Pattern explanation:
  //   \b(FROM|JOIN)\s+events\b — the keyword + table name on a word boundary
  //   (?!\s*WHERE\s+properties\.\$group_0\s*=\s*'[0-9a-f-]{36}')
  //                          negative lookahead — don't rewrite events refs
  //                          that are already inside our wrapped subquery
  //                          (won't happen with a single pass, but be safe)
  //   (\s+(?:AS\s+)?(\w+))?  optional alias capture
  return hogql.replace(
    /\b(FROM|JOIN)\s+events\b(\s+(?:AS\s+)?(\w+))?/gi,
    (_match, keyword, aliasGroup, _aliasName) => {
      const alias = aliasGroup ? aliasGroup : "";
      return `${keyword} ${filtered}${alias}`;
    },
  );
}

export function isPosthogConfigured(env: Env): boolean {
  return Boolean(
    env.POSTHOG_HOST &&
      env.POSTHOG_PROJECT_ID &&
      env.POSTHOG_PROJECT_API_KEY &&
      env.POSTHOG_MASTER_API_KEY,
  );
}

interface SharedPosthogConfig {
  host: string;
  projectId: number;
  writeKey: string;
  masterKey: string;
}

function getSharedPosthog(env: Env): SharedPosthogConfig {
  if (!isPosthogConfigured(env)) {
    throw errors.internal(
      "agentry deployment is missing the shared PostHog config. " +
        "Required secrets: POSTHOG_HOST, POSTHOG_PROJECT_ID, " +
        "POSTHOG_PROJECT_API_KEY, POSTHOG_MASTER_API_KEY.",
    );
  }
  return {
    host: env.POSTHOG_HOST!.replace(/\/$/, ""),
    projectId: Number(env.POSTHOG_PROJECT_ID),
    writeKey: env.POSTHOG_PROJECT_API_KEY!,
    masterKey: env.POSTHOG_MASTER_API_KEY!,
  };
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

  // 2. Use the master key as the per-user read token. We'd prefer to mint a
  //    project-scoped Personal API Key here, but PostHog's /api/personal_api_keys/
  //    endpoint requires a user *session* (cookie) — it explicitly rejects
  //    requests authenticated with another personal API key:
  //      "This action does not support personal API key access"
  //    So we reuse the master key. Trade-off: a leak of one user's encrypted
  //    read_token row in agentry's DB decrypts to a key with ORG-WIDE read
  //    access (not just that user's team). This is bounded by:
  //      - Tokens are AES-GCM encrypted at rest with AGENTRY_TOKEN_ENC_KEY
  //      - The decrypted token never leaves the agentry worker
  //      - All HogQL queries scope by team_id at the API level
  //    Acceptable for v0 multi-tenant PostHog Hobby; revisit when PostHog
  //    ships a "mint-key-for-user" admin endpoint (or we move to an OAuth
  //    impersonation flow).
  return {
    posthogProjectId: proj.id,
    writeApiKey: proj.api_token,
    readToken: masterKey,
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

// ---------------------------------------------------------------------------
// Per-user "provisioning" — no-op in the shared-project model.
// ---------------------------------------------------------------------------

// Previously this created a fresh PostHog project per agentry user. After the
// shared-project + groups refactor, there's nothing per-user to provision —
// the shared project pre-exists, and group identification is implicit (PostHog
// auto-registers a group_type on first capture that includes `$groups`).
//
// Kept callable for back-compat: callers in auth.ts still invoke it; the
// returned shape is the same so they can keep destructuring `provisioned` +
// `posthogProjectId`. `provisioned` is true when the shared config is
// healthy (a green check the agent can surface), false otherwise.
export async function ensurePosthogForUser(
  env: Env,
  _userId: string,
  _githubUsername: string,
): Promise<{ provisioned: boolean; posthogProjectId: number | null }> {
  if (!isPosthogConfigured(env)) {
    return { provisioned: false, posthogProjectId: null };
  }
  const ph = getSharedPosthog(env);
  // Identify the user as a group so PostHog has a row for them in the groups
  // table (helps with cohort queries on the dashboard side). Best-effort:
  // capture-side `$groups` already auto-creates the membership; this just
  // adds friendly properties. If the identify fails we still return success.
  await identifyAgentryUserGroup(env, _userId, _githubUsername).catch(() => undefined);
  return { provisioned: true, posthogProjectId: ph.projectId };
}

// Send a `$groupidentify` event so the group shows up in PostHog's group UI
// with a human-friendly name. Idempotent; PostHog merges properties.
async function identifyAgentryUserGroup(
  env: Env,
  userId: string,
  githubUsername: string,
): Promise<void> {
  const ph = getSharedPosthog(env);
  const payload = {
    api_key: ph.writeKey,
    event: "$groupidentify",
    distinct_id: `agentry-system-${userId}`,
    properties: {
      $group_type: AGENTRY_USER_GROUP_TYPE,
      $group_key: userId,
      $group_set: {
        name: githubUsername ? `agentry-user-${githubUsername}` : `agentry-user-${userId}`,
        github_username: githubUsername,
        agentry_user_id: userId,
      },
    },
    timestamp: new Date().toISOString(),
  };
  await withTimeout(
    fetch(`${ph.host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    PROVISION_TIMEOUT_MS,
  );
}

// ---------------------------------------------------------------------------
// Capture: forward agentry's /v1/track events into the shared PostHog project,
// tagged with the agentry-user group so per-user filtering works at query time.
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
  const ph = getSharedPosthog(env);

  // Stamp $groups so every event is queryable by group_key=userId. PostHog
  // accepts arbitrary group_type keys and auto-registers on first capture;
  // no explicit group-type creation needed.
  const userProps = body.properties ?? {};
  const userGroups =
    typeof userProps["$groups"] === "object" && userProps["$groups"] !== null
      ? (userProps["$groups"] as Record<string, unknown>)
      : {};
  const properties = {
    ...userProps,
    $groups: {
      ...userGroups,
      [AGENTRY_USER_GROUP_TYPE]: userId,
    },
  };

  const payload = {
    api_key: ph.writeKey,
    event: body.event,
    distinct_id:
      body.distinct_id ?? (userProps["$user_id"] as string | undefined) ?? "anonymous",
    properties,
    timestamp:
      typeof body.timestamp === "number"
        ? new Date(body.timestamp * 1000).toISOString()
        : undefined,
  };

  const res = await withTimeout(
    fetch(`${ph.host}/capture/`, {
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
// HogQL passthrough — server-side group filter ensures cross-user isolation.
// ---------------------------------------------------------------------------

export interface RunHogQlOpts {
  /** If true, skip the user-supplied-HogQL blocklist (recipes/server-controlled
   *  queries only — they're already safe by construction). Group-filter
   *  injection STILL applies regardless. */
  trusted?: boolean;
}

export async function runHogQl(
  env: Env,
  userId: string,
  query: string,
  opts: RunHogQlOpts = {},
): Promise<{ results: unknown[]; columns: string[] | null; types: string[] | null }> {
  if (!isPosthogConfigured(env)) throw errors.internal("posthog not configured");
  const ph = getSharedPosthog(env);

  // CRITICAL ISOLATION: PostHog's /api/projects/:id/query/ has a `filters`
  // block, but it's only applied when the HogQL explicitly references
  // `{filters}` as a template token. Plain HogQL bypasses it silently — we
  // verified this by reading PostHog's generated ClickHouse SQL: the filter
  // block was dropped, returning cross-user events. (See decisions log for
  // the smoke-test that caught this.)
  //
  // We inject the group filter directly into the HogQL string here. The
  // userId is a v7 UUID validated by uuidv7Re (Drizzle's primary-key shape),
  // so embedding it as a literal is safe — no SQL injection surface. We
  // still wrap with single quotes and reject anything non-UUID defensively.
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    throw errors.internal(
      `Refusing to run HogQL: userId is not a UUID. Got: ${userId.slice(0, 20)}…`,
    );
  }
  // Defense-in-depth: reject user-supplied queries with constructs we don't
  // want to deal with (comments, references to non-events tables). Recipes
  // skip validation — they're safe by construction.
  if (!opts.trusted) validateHogQl(query);
  // Group-filter wrap applies to BOTH paths: every `FROM events` reference
  // becomes a per-user-filtered subquery. UNION, CTEs, subqueries — all safe
  // because each events scan is independently scoped.
  const filteredQuery = wrapEventsTable(query, userId);

  const url = `${ph.host}/api/projects/${ph.projectId}/query/`;
  const reqBody = {
    query: {
      kind: "HogQLQuery",
      query: filteredQuery,
    },
  };
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ph.masterKey}`,
      },
      body: JSON.stringify(reqBody),
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
