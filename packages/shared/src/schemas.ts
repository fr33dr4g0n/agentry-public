import { z } from "zod";

// Permissive: real Sentry SDK payloads have a lot of optional fields.
// We accept anything well-formed and only require enough to fingerprint.

const StackFrameSchema = z.object({
  filename: z.string().nullable().optional(),
  function: z.string().nullable().optional(),
  lineno: z.number().int().nullable().optional(),
  colno: z.number().int().nullable().optional(),
  in_app: z.boolean().nullable().optional(),
  context_line: z.string().nullable().optional(),
}).passthrough();

const ExceptionValueSchema = z.object({
  type: z.string().optional(),
  value: z.string().optional(),
  stacktrace: z.object({ frames: z.array(StackFrameSchema).optional() }).optional(),
}).passthrough();

export const IngestEventSchema = z.object({
  event_id: z.string().optional(),
  timestamp: z.number().optional(),
  platform: z.string().optional(),
  environment: z.string().optional(),
  release: z.string().optional(),
  deploy_sha: z.string().optional(),
  server_name: z.string().optional(),
  level: z.enum(["fatal", "error", "warning", "info", "debug"]).optional(),
  message: z.union([
    z.string(),
    z.object({ formatted: z.string().optional(), message: z.string().optional() }).passthrough(),
  ]).optional(),
  exception: z.object({ values: z.array(ExceptionValueSchema).optional() }).optional(),
  breadcrumbs: z.object({ values: z.array(z.record(z.unknown())).optional() }).optional(),
  request: z.record(z.unknown()).optional(),
  user: z.record(z.unknown()).optional(),
  tags: z.record(z.string()).optional(),
  extra: z.record(z.unknown()).optional(),
}).passthrough();

export type IngestEvent = z.infer<typeof IngestEventSchema>;

export const SignupRequestSchema = z.object({
  email: z.string().email().max(254),
});

export const CreateProjectRequestSchema = z.object({
  name: z.string().min(1).max(100),
  repo_url: z.string().url().max(500).optional(),
  default_branch: z.string().max(100).optional(),
  local_path: z.string().max(500).optional(),
});

export const UpdateCaseRequestSchema = z.object({
  status: z.enum(["open", "investigating", "resolved", "spurious", "ignored"]).optional(),
  agent_summary: z.string().max(8000).optional(),
  pr_url: z.string().url().max(500).optional(),
});

export const RecordSuppressionRequestSchema = z.object({
  fingerprint_pattern: z.string().min(1).max(500),
  action: z.enum(["auto_ignore", "auto_resolve", "prompt_hint"]),
  reason: z.string().max(1000).optional(),
  hint_text: z.string().max(2000).optional(),
});

export const RecordAgentRunRequestSchema = z.object({
  case_id: z.string(),
  status: z.enum(["pr_opened", "escalated", "marked_spurious", "failed"]),
  summary_md: z.string().max(8000).optional(),
  pr_url: z.string().url().max(500).optional(),
});

export type SignupRequest = z.infer<typeof SignupRequestSchema>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type UpdateCaseRequest = z.infer<typeof UpdateCaseRequestSchema>;
export type RecordSuppressionRequest = z.infer<typeof RecordSuppressionRequestSchema>;
export type RecordAgentRunRequest = z.infer<typeof RecordAgentRunRequestSchema>;
