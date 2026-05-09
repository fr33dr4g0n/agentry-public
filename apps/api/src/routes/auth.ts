import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  AgentryError,
  SignupRequestSchema,
  errors,
  mintApiKey,
  uuidv7,
} from "@agentry/shared";
import { apiKeys, users } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey } from "../middleware.js";
import type { AppBindings } from "../env.js";

const auth = new Hono<AppBindings>();

auth.post("/signup", async (c) => {
  if (c.env.ALLOW_UNVERIFIED_SIGNUP !== "true") {
    throw new AgentryError({
      status: 503,
      code: "signup_disabled",
      message: "Unverified signup is disabled on this deployment.",
      nextAction:
        "Contact the operator to enable ALLOW_UNVERIFIED_SIGNUP, or wait for v0.1 magic-link auth.",
    });
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  const parsed = SignupRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidPayload({ zod: parsed.error.flatten() });
  }
  const email = parsed.data.email.toLowerCase().trim();

  const db = getDb(c.env);

  // Find or create the user.
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  let userId: string;
  if (existing[0]) {
    userId = existing[0].id;
  } else {
    userId = uuidv7();
    await db.insert(users).values({
      id: userId,
      email,
      createdAt: Math.floor(Date.now() / 1000),
    });
  }

  const minted = await mintApiKey();
  await db.insert(apiKeys).values({
    id: uuidv7(),
    userId,
    prefix: minted.prefix,
    keyHash: minted.hash,
    name: "signup",
    createdAt: Math.floor(Date.now() / 1000),
  });

  return c.json({
    api_key: minted.raw,
    user_id: userId,
    prefix: minted.prefix,
    next_action:
      "Store this api_key in ~/.agentry/config.json — it won't be shown again. " +
      "Then call POST /v1/projects to create a project.",
  });
});

auth.post("/keys/rotate", requireApiKey(), async (c) => {
  const user = c.get("user");
  const currentKey = c.get("apiKey");
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
    .where(eq(apiKeys.id, currentKey.id));

  return c.json({
    api_key: minted.raw,
    user_id: user.id,
    prefix: minted.prefix,
    next_action:
      "Replace the old api_key in ~/.agentry/config.json with this one. The old key has been revoked.",
  });
});

export default auth;
