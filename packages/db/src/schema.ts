import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch())`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  emailIdx: uniqueIndex("users_email_idx").on(t.email),
}));

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  name: text("name"),
  lastUsedAt: integer("last_used_at"),
  createdAt: integer("created_at").notNull().default(now),
  revokedAt: integer("revoked_at"),
}, (t) => ({
  hashIdx: uniqueIndex("api_keys_hash_idx").on(t.keyHash),
  userIdx: index("api_keys_user_idx").on(t.userId),
}));

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  repoUrl: text("repo_url"),
  defaultBranch: text("default_branch").notNull().default("main"),
  localPath: text("local_path"),
  dsnPrefix: text("dsn_prefix").notNull(),
  dsnHash: text("dsn_hash").notNull(),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  userIdx: index("projects_user_idx").on(t.userId),
  dsnHashIdx: uniqueIndex("projects_dsn_hash_idx").on(t.dsnHash),
}));

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  fingerprint: text("fingerprint").notNull(),
  errorType: text("error_type").notNull(),
  message: text("message").notNull(),
  stack: text("stack").notNull(),               // JSON-encoded StackFrame[]
  deploySha: text("deploy_sha"),
  environment: text("environment"),
  breadcrumbsJson: text("breadcrumbs_json"),
  requestJson: text("request_json"),
  tagsJson: text("tags_json"),
  extraJson: text("extra_json"),
  receivedAt: integer("received_at").notNull().default(now),
}, (t) => ({
  projFpIdx: index("events_proj_fp_idx").on(t.projectId, t.fingerprint, t.receivedAt),
}));

export const cases = sqliteTable("cases", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  fingerprint: text("fingerprint").notNull(),
  errorType: text("error_type").notNull(),
  message: text("message").notNull(),
  status: text("status", { enum: ["open", "investigating", "resolved", "spurious", "ignored"] })
    .notNull()
    .default("open"),
  eventCount: integer("event_count").notNull().default(0),
  firstSeenAt: integer("first_seen_at").notNull().default(now),
  lastSeenAt: integer("last_seen_at").notNull().default(now),
  lastDeploySha: text("last_deploy_sha"),
  agentSummary: text("agent_summary"),
  prUrl: text("pr_url"),
}, (t) => ({
  projFpIdx: uniqueIndex("cases_proj_fp_idx").on(t.projectId, t.fingerprint),
  projStatusIdx: index("cases_proj_status_idx").on(t.projectId, t.status, t.lastSeenAt),
}));

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  startedAt: integer("started_at").notNull().default(now),
  finishedAt: integer("finished_at"),
  status: text("status", {
    enum: ["pr_opened", "escalated", "marked_spurious", "failed", "running"],
  }).notNull().default("running"),
  summaryMd: text("summary_md"),
  prUrl: text("pr_url"),
  action: text("action"),
}, (t) => ({
  caseIdx: index("agent_runs_case_idx").on(t.caseId, t.startedAt),
}));

export const suppressionEntries = sqliteTable("suppression_entries", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  fingerprintPattern: text("fingerprint_pattern").notNull(),
  action: text("action", { enum: ["auto_ignore", "auto_resolve", "prompt_hint"] }).notNull(),
  reason: text("reason"),
  hintText: text("hint_text"),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  projIdx: index("suppression_proj_idx").on(t.projectId),
}));

export type User = typeof users.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Case = typeof cases.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type SuppressionEntry = typeof suppressionEntries.$inferSelect;
