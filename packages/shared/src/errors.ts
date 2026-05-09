// Agent-friendly error responses.
// Every error includes a `code` (machine-readable) and `next_action` (what the agent should try).

export interface AgentryErrorBody {
  error: {
    code: string;
    message: string;
    next_action?: string;
    details?: Record<string, unknown>;
  };
}

export class AgentryError extends Error {
  status: number;
  code: string;
  nextAction?: string;
  details?: Record<string, unknown>;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    nextAction?: string;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.status = opts.status;
    this.code = opts.code;
    this.nextAction = opts.nextAction;
    this.details = opts.details;
  }

  toResponseBody(): AgentryErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.nextAction ? { next_action: this.nextAction } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const errors = {
  invalidPayload(details?: Record<string, unknown>) {
    return new AgentryError({
      status: 400,
      code: "invalid_payload",
      message: "Request body did not match the expected schema.",
      nextAction: "Inspect details.zod and fix the offending fields, then retry.",
      details,
    });
  },
  unauthorized(reason: string = "Missing or invalid Authorization header.") {
    return new AgentryError({
      status: 401,
      code: "unauthorized",
      message: reason,
      nextAction:
        "If you have an api_key, send `Authorization: Bearer <api_key>`. " +
        "If you don't have one, call POST /v1/auth/signup with an email to get one.",
    });
  },
  invalidApiKey() {
    return new AgentryError({
      status: 401,
      code: "invalid_api_key",
      message: "API key not recognized or revoked.",
      nextAction:
        "Call POST /v1/auth/signup with the user's email to mint a fresh key. " +
        "(v0 has no email verification, so the same email always returns a working key.)",
    });
  },
  invalidDsn() {
    return new AgentryError({
      status: 401,
      code: "invalid_dsn",
      message: "DSN not recognized.",
      nextAction:
        "Verify the DSN. The agent should call agentry_list_projects via MCP to look up the right DSN, or " +
        "agentry_create_project to mint a new one.",
    });
  },
  notFound(resource: string) {
    return new AgentryError({
      status: 404,
      code: "not_found",
      message: `${resource} not found.`,
      nextAction: `Verify the id. List available ${resource}s if unsure.`,
    });
  },
  forbidden(reason: string = "You do not have access to this resource.") {
    return new AgentryError({
      status: 403,
      code: "forbidden",
      message: reason,
      nextAction:
        "Confirm the resource id belongs to a project owned by the authenticated user.",
    });
  },
  rateLimited() {
    return new AgentryError({
      status: 429,
      code: "rate_limited",
      message: "Too many requests.",
      nextAction: "Back off and retry with exponential delay (start at 1s).",
    });
  },
  internal(message = "Internal server error.") {
    return new AgentryError({
      status: 500,
      code: "internal",
      message,
      nextAction: "Retry once. If it persists, the server has a bug — open an issue.",
    });
  },
};
