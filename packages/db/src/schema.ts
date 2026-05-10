import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch())`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  // GitHub identity. github_id is the canonical identifier; email may be missing
  // if a user hides it on GitHub but we always try to fetch a verified one.
  githubId: integer("github_id").notNull(),
  githubUsername: text("github_username").notNull(),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  githubIdIdx: uniqueIndex("users_github_id_idx").on(t.githubId),
  emailIdx: index("users_email_idx").on(t.email),
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

// Deploy events. Agents read recent deploys to attribute case regressions.
export const deploys = sqliteTable("deploys", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sha: text("sha").notNull(),
  branch: text("branch"),
  environment: text("environment"),
  message: text("message"),
  url: text("url"),
  actor: text("actor"),
  receivedAt: integer("received_at").notNull().default(now),
}, (t) => ({
  projTimeIdx: index("deploys_proj_time_idx").on(t.projectId, t.receivedAt),
}));

// Per-month usage counters keyed by (project_id, period, signal_type).
// Incremented on every ingest. Lets the agent see "you've used X of your Y events".
export const usageCounters = sqliteTable("usage_counters", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  // YYYY-MM, e.g. "2026-05"
  period: text("period").notNull(),
  // "errors" | "analytics" | "deploys"
  signalType: text("signal_type").notNull(),
  count: integer("count").notNull().default(0),
}, (t) => ({
  pk: uniqueIndex("usage_counters_pk").on(t.projectId, t.period, t.signalType),
}));

// Alert definitions. Customer's cron calls /evaluate to fire the webhook
// when threshold crosses. agentry stores the recipe + threshold + which webhook.
export const alerts = sqliteTable("alerts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  recipeId: text("recipe_id").notNull(),
  paramsJson: text("params_json").notNull().default("{}"),
  // Which numeric column of the recipe's result rows we evaluate
  thresholdColumn: text("threshold_column").notNull(),
  // gt / gte / lt / lte / eq
  thresholdOp: text("threshold_op").notNull(),
  thresholdValue: text("threshold_value").notNull(),  // stored as string to handle floats safely
  // Which webhook to fire when crossed; null = use all active project webhooks
  webhookId: text("webhook_id"),
  active: integer("active").notNull().default(1),
  createdAt: integer("created_at").notNull().default(now),
  lastEvaluatedAt: integer("last_evaluated_at"),
  lastTriggeredAt: integer("last_triggered_at"),
  lastValue: text("last_value"),
}, (t) => ({
  projIdx: index("alerts_proj_idx").on(t.projectId, t.active),
}));

// Webhook subscriptions. Each project can register multiple URLs for specific
// event types. Signing secret is stored as a hash; raw value shown once at creation.
export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  description: text("description"),
  events: text("events").notNull(),  // JSON array: ["case.created", "case.resolved", "deploy.recorded"]
  signingSecretPrefix: text("signing_secret_prefix").notNull(),
  signingSecretHash: text("signing_secret_hash").notNull(),
  active: integer("active").notNull().default(1),  // 0/1 boolean
  createdAt: integer("created_at").notNull().default(now),
  lastFiredAt: integer("last_fired_at"),
  lastStatus: integer("last_status"),
  lastError: text("last_error"),
}, (t) => ({
  projIdx: index("webhooks_proj_idx").on(t.projectId, t.active),
}));

// One PostHog project per agentry user, auto-provisioned on first GitHub login.
// Tokens are encrypted at rest using AES-GCM with AGENTRY_TOKEN_ENC_KEY.
export const posthogProjects = sqliteTable("posthog_projects", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  posthogProjectId: integer("posthog_project_id").notNull(),
  posthogProjectApiKey: text("posthog_project_api_key").notNull(),  // write key (capture)
  readTokenEnc: text("read_token_enc").notNull(),                   // personal API key, encrypted
  readTokenIv: text("read_token_iv").notNull(),                     // AES-GCM IV (base64url)
  posthogHost: text("posthog_host").notNull(),
  createdAt: integer("created_at").notNull().default(now),
}, (t) => ({
  posthogProjIdx: uniqueIndex("posthog_projects_ph_id_idx").on(t.posthogProjectId),
}));

export type User = typeof users.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Case = typeof cases.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type SuppressionEntry = typeof suppressionEntries.$inferSelect;
export type Deploy = typeof deploys.$inferSelect;
export type PosthogProject = typeof posthogProjects.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type UsageCounter = typeof usageCounters.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
