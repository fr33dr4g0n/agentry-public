import { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { errors, mintApiKey, uuidv7 } from "@agentrysh/shared";
import { apiKeys, users } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey } from "../middleware.js";
import { ensurePosthogForUser, isPosthogConfigured } from "../posthog.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// GitHub Device Flow
//
// 1. POST /v1/auth/device       — proxy to GitHub, return device + user code
// 2. (user authorizes in browser)
// 3. POST /v1/auth/device/poll  — exchange device_code for access token, look
//                                 up the GitHub user, upsert by github_id,
//                                 mint an agentry api_key, return it
// ---------------------------------------------------------------------------

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";
const SCOPE = "read:user user:email";

router.post("/device", async (c) => {
  if (!c.env.GITHUB_CLIENT_ID) {
    throw errors.internal("GITHUB_CLIENT_ID not configured.");
  }

  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    scope: SCOPE,
  });
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    throw errors.internal(`GitHub device-code request failed (status ${res.status}).`);
  }
  const body = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };
  if (body.error || !body.device_code) {
    throw errors.internal(
      `GitHub device flow error: ${body.error_description ?? body.error ?? "unknown"}`,
    );
  }

  return c.json({
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    expires_in: body.expires_in,
    interval: body.interval ?? 5,
    next_action:
      "Show the user `verification_uri` and `user_code`. Once they've authorized in their browser, " +
      "poll POST /v1/auth/device/poll with the device_code every `interval` seconds until you get an api_key.",
  });
});

router.post("/device/poll", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  const deviceCode =
    body && typeof body === "object"
    && typeof (body as { device_code?: unknown }).device_code === "string"
      ? (body as { device_code: string }).device_code
      : null;
  if (!deviceCode) {
    throw errors.invalidPayload({ reason: "device_code is required" });
  }

  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    throw errors.internal("GITHUB_CLIENT_ID/SECRET not configured.");
  }

  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    client_secret: c.env.GITHUB_CLIENT_SECRET,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const tokenRes = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!tokenRes.ok) {
    throw errors.internal(`GitHub token exchange failed (status ${tokenRes.status}).`);
  }
  const tokenBody = (await tokenRes.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenBody.error) {
    switch (tokenBody.error) {
      case "authorization_pending":
        return c.json({
          status: "pending",
          next_action:
            "User has not authorized yet. Wait `interval` seconds and call this again.",
        });
      case "slow_down":
        return c.json({
          status: "slow_down",
          next_action:
            "GitHub asked us to back off — wait at least 5 more seconds before polling again.",
        });
      case "expired_token":
        return c.json(
          {
            status: "expired",
            next_action: "Restart the flow with POST /v1/auth/device.",
          },
          400,
        );
      case "access_denied":
        return c.json(
          {
            status: "denied",
            next_action:
              "User declined the authorization. Confirm with the user and restart with POST /v1/auth/device if so.",
          },
          400,
        );
      default:
        throw errors.internal(
          `GitHub device-flow error: ${tokenBody.error_description ?? tokenBody.error}`,
        );
    }
  }

  if (!tokenBody.access_token) {
    throw errors.internal("GitHub returned no access_token and no error code.");
  }

  const ghHeaders = {
    accept: "application/vnd.github+json",
    "user-agent": "agentry",
    authorization: `Bearer ${tokenBody.access_token}`,
  } as const;

  const userRes = await fetch(USER_URL, { headers: ghHeaders });
  if (!userRes.ok) {
    throw errors.internal(`GitHub /user fetch failed (status ${userRes.status}).`);
  }
  const ghUser = (await userRes.json()) as {
    id?: number;
    login?: string;
    email?: string | null;
    avatar_url?: string;
  };
  if (!ghUser.id || !ghUser.login) {
    throw errors.internal("GitHub /user response missing id or login.");
  }

  let email: string | null = ghUser.email ?? null;
  if (!email) {
    const emailsRes = await fetch(EMAILS_URL, { headers: ghHeaders });
    if (emailsRes.ok) {
      const list = (await emailsRes.json()) as Array<{
        email?: string;
        primary?: boolean;
        verified?: boolean;
      }>;
      const primary =
        list.find((e) => e.primary && e.verified) ?? list.find((e) => e.verified);
      if (primary?.email) email = primary.email;
    }
  }

  return await provisionUserAndMintKey(c, {
    githubId: ghUser.id,
    githubUsername: ghUser.login,
    email,
    avatarUrl: ghUser.avatar_url ?? null,
  });
});

// ---------------------------------------------------------------------------
// Test login (gated). Used by local e2e + dogfood scripts ONLY.
// Production secret store must NOT set ENABLE_TEST_LOGIN.
// ---------------------------------------------------------------------------
router.post("/_test/login", async (c) => {
  if (c.env.ENABLE_TEST_LOGIN !== "true") {
    throw errors.notFound("route");
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  const email =
    body && typeof body === "object"
    && typeof (body as { email?: unknown }).email === "string"
      ? (body as { email: string }).email
      : null;
  if (!email) throw errors.invalidPayload({ reason: "email is required" });

  const githubId = await emailToFakeGithubId(email);
  const githubUsername = email.split("@")[0]!.replace(/[^a-z0-9_-]/gi, "_");

  return await provisionUserAndMintKey(c, {
    githubId,
    githubUsername,
    email,
    avatarUrl: null,
  });
});

// ---------------------------------------------------------------------------
// Key rotation (auth required). Useful for users to rotate keys without redoing
// the GitHub flow.
// ---------------------------------------------------------------------------
router.post("/keys/rotate", requireApiKey(), async (c) => {
  const user = c.get("user");
  const currentApiKey = c.get("apiKey");
  const db = getDb(c.env);

  const minted = await mintApiKey();
  await db.insert(apiKeys).values({
    id: uuidv7(),
    userId: user.id,
    prefix: minted.prefix,
    keyHash: minted.hash,
    name: "rotated",
    createdAt: Math.floor(Date.now() / 1000),
  });
  await db
    .update(apiKeys)
    .set({ revokedAt: Math.floor(Date.now() / 1000) })
    .where(eq(apiKeys.id, currentApiKey.id));

  return c.json({
    api_key: minted.raw,
    user_id: user.id,
    prefix: minted.prefix,
    next_action:
      "Store this api_key — your previous key is now revoked. Update ~/.agentry/config.json.",
  });
});

// Idempotent recovery: re-attempt PostHog provisioning for the authed user.
// First-login provisioning is best-effort — if PostHog was 503 at the moment of
// login, the user ends up with an api_key but no analytics backend, and every
// /v1/track/ POST will fail with "user has no PostHog project provisioned".
// This endpoint lets the agent recover without rerunning the GitHub device
// flow (which would mint + persist a new api_key, churning the user's config).
router.post("/posthog/provision", requireApiKey(), async (c) => {
  const user = c.get("user");
  if (!isPosthogConfigured(c.env)) {
    return c.json({
      provisioned: false,
      posthog_project_id: null,
      reason: "agentry is not configured with PostHog credentials on this deployment.",
      next_action:
        "Nothing the customer can do — the agentry operator hasn't configured PostHog yet. " +
        "Errors and deploys still work; analytics ingest will continue to 503 until PostHog is wired.",
    }, 503);
  }
  // ensurePosthogForUser is idempotent: returns existing row if present, else
  // creates a fresh PostHog project. Errors propagate to the caller so the
  // agent sees the actual upstream message (PostHog 503 etc).
  try {
    const r = await ensurePosthogForUser(c.env, user.id, user.githubUsername);
    return c.json({
      provisioned: r.provisioned,
      posthog_project_id: r.posthogProjectId,
      already_existed: !r.provisioned && r.posthogProjectId !== null,
      next_action: r.posthogProjectId
        ? "Analytics backend is wired. Re-run agentry_verify_install — the analytics signal " +
          "should now ✅. If it still fails, the issue is elsewhere (event shape, distinct_id, etc)."
        : "Provisioning did not return a project id — PostHog is likely still 503. Retry in 30–60s.",
    });
  } catch (err) {
    return c.json({
      provisioned: false,
      posthog_project_id: null,
      error: err instanceof Error ? err.message : String(err),
      next_action:
        "Upstream PostHog provisioning failed. Wait 30–60s and retry agentry_repair_analytics. " +
        "If it stays down, errors and deploys still work — analytics ingest will queue until PostHog recovers.",
    }, 503);
  }
});

export default router;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function provisionUserAndMintKey(
  c: Context<AppBindings>,
  ident: {
    githubId: number;
    githubUsername: string;
    email: string | null;
    avatarUrl: string | null;
  },
) {
  const db = getDb(c.env);

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.githubId, ident.githubId))
    .limit(1);

  let userId: string;
  if (existing[0]) {
    userId = existing[0].id;
    await db
      .update(users)
      .set({
        githubUsername: ident.githubUsername,
        email: ident.email,
        avatarUrl: ident.avatarUrl,
      })
      .where(eq(users.id, userId));
  } else {
    userId = uuidv7();
    await db.insert(users).values({
      id: userId,
      githubId: ident.githubId,
      githubUsername: ident.githubUsername,
      email: ident.email,
      avatarUrl: ident.avatarUrl,
      createdAt: Math.floor(Date.now() / 1000),
    });
  }

  const minted = await mintApiKey();
  await db.insert(apiKeys).values({
    id: uuidv7(),
    userId,
    prefix: minted.prefix,
    keyHash: minted.hash,
    name: "github-oauth",
    createdAt: Math.floor(Date.now() / 1000),
  });

  // Best-effort PostHog provisioning. If PostHog is unconfigured or unreachable,
  // we still hand back the API key and surface the failure as a `posthog`
  // sub-object so the calling agent can decide whether to retry later.
  let posthog: { provisioned: boolean; posthog_project_id: number | null; error?: string } = {
    provisioned: false,
    posthog_project_id: null,
  };
  if (isPosthogConfigured(c.env)) {
    try {
      const r = await ensurePosthogForUser(c.env, userId, ident.githubUsername);
      posthog = {
        provisioned: r.provisioned,
        posthog_project_id: r.posthogProjectId,
      };
    } catch (err) {
      posthog = {
        provisioned: false,
        posthog_project_id: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return c.json({
    status: "ok",
    api_key: minted.raw,
    user_id: userId,
    prefix: minted.prefix,
    github: {
      id: ident.githubId,
      username: ident.githubUsername,
      email: ident.email,
      avatar_url: ident.avatarUrl,
    },
    posthog,
    next_action:
      "Store this api_key in ~/.agentry/config.json — it won't be shown again. " +
      "Then call POST /v1/projects to create a project, then run agentry_install_guide " +
      "for the comprehensive setup checklist.",
  });
}

async function emailToFakeGithubId(email: string): Promise<number> {
  const enc = new TextEncoder().encode(email.toLowerCase());
  const buf = await globalThis.crypto.subtle.digest("SHA-256", enc);
  const view = new DataView(buf);
  const n = view.getUint32(0) & 0x7fffffff;
  return n || 1;
}
