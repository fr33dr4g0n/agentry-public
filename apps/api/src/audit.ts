// Append-only audit log of agent-driven mutations.
// Every mutating handler writes one row before returning success. The
// agentry_recent_changes MCP tool reads the last N hours back, giving the
// user a window into "what did the agent do unattended?"
//
// Failures to write the audit row are logged but NEVER propagated to the
// caller — observability must never break user-visible operations.

import { uuidv7 } from "@agentrysh/shared";
import { auditLog } from "@agentry/db/schema";
import type { Context } from "hono";
import type { AppBindings } from "./env.js";
import { getDb } from "./db.js";

export type AuditAction =
  | "feature_flag.created"
  | "feature_flag.updated"
  | "feature_flag.deleted"
  | "cohort.created"
  | "cohort.deleted"
  | "survey.created"
  | "survey.deleted"
  | "publication.minted"
  | "publication.revoked"
  | "session_replay.configured"
  | "ab_test.created";

export type AuditResourceType =
  | "feature_flag"
  | "cohort"
  | "survey"
  | "publication"
  | "session_replay"
  | "ab_test";

interface AuditInput {
  userId: string;
  projectId?: string | null;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string | number | null;
  summary?: string;
  metadata?: Record<string, unknown>;
}

/** Best-effort audit-log write. Never throws. */
export async function audit(
  c: Context<AppBindings>,
  input: AuditInput,
): Promise<void> {
  try {
    const db = getDb(c.env);
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      null;
    const ua = c.req.header("user-agent") ?? null;
    await db.insert(auditLog).values({
      id: uuidv7(),
      userId: input.userId,
      projectId: input.projectId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId:
        input.resourceId === undefined || input.resourceId === null
          ? null
          : String(input.resourceId),
      summary: input.summary ?? null,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      ip,
      ua,
    });
  } catch (err) {
    console.error("[audit] failed to write log row:", err);
  }
}
