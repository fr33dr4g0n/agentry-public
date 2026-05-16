import type { Context, MiddlewareHandler } from "hono";
import { errors, sha256Hex } from "@agentrysh/shared";
import { apiKeys, cases, projects, users } from "@agentry/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { ApiKey, Case, Project, User } from "@agentry/db/schema";
import { getDb } from "./db.js";
import type { AppBindings } from "./env.js";

/**
 * Safely extract a waitUntil function from a Hono Context.
 *
 * Hono's `c.executionCtx` getter THROWS synchronously when the underlying
 * runtime is not Cloudflare Workers (e.g. plain Node in tests, or any non-Workers
 * fetch handler). Optional chaining (`c.executionCtx?.waitUntil`) does NOT catch
 * a thrown getter — it only protects against null/undefined receivers.
 *
 * This helper handles both cases: returns a real waitUntil when available,
 * falls back to fire-and-forget with error swallowing otherwise.
 */
export function waitUntilOf(c: Context<AppBindings>): (p: Promise<unknown>) => void {
  try {
    const ec = c.executionCtx;
    if (ec && typeof ec.waitUntil === "function") {
      return (p) => ec.waitUntil(p);
    }
  } catch {
    /* no executionCtx — fall through to inline */
  }
  return (p) => {
    void p.catch(() => {});
  };
}

export function requireApiKey(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!auth) throw errors.unauthorized();
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m || !m[1]) throw errors.unauthorized();
    const token = m[1].trim();
    if (!token) throw errors.unauthorized();

    const hash = await sha256Hex(token);
    const db = getDb(c.env);
    const rows = await db
      .select({ apiKey: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
      .limit(1);

    const row = rows[0];
    if (!row) throw errors.invalidApiKey();

    c.set("apiKey", row.apiKey);
    c.set("user", row.user);

    // Best-effort touch — don't block on it.
    try {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: Math.floor(Date.now() / 1000) })
        .where(eq(apiKeys.id, row.apiKey.id));
    } catch {
      // ignore — purely an observability field
    }

    await next();
  };
}

export async function requireProjectAccess(
  c: Context<AppBindings>,
  projectId: string,
): Promise<Project> {
  const user = c.get("user") as User;
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const proj = rows[0];
  if (!proj) throw errors.notFound("project");
  if (proj.userId !== user.id) throw errors.forbidden();
  return proj;
}

export async function requireCaseAccess(
  c: Context<AppBindings>,
  caseId: string,
): Promise<{ case: Case; project: Project }> {
  const user = c.get("user") as User;
  const db = getDb(c.env);
  const rows = await db
    .select({ c: cases, p: projects })
    .from(cases)
    .innerJoin(projects, eq(projects.id, cases.projectId))
    .where(eq(cases.id, caseId))
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.notFound("case");
  if (row.p.userId !== user.id) throw errors.forbidden();
  return { case: row.c, project: row.p };
}

// Re-export for type inference convenience.
export type { ApiKey };
