// Sentry-protocol DSN-like format:
//   https://<token>@<host>/v1/store/<project_id>/
// We accept that exact format from existing Sentry SDKs, AND a simpler agentry-native form:
//   <token>@<host>/<project_id>
// Plus the bare token form `agnt_<projectId>_<token>` for our own SDK.

export interface ParsedSentryUrl {
  protocol: string;
  publicKey: string;
  host: string;
  port: string;
  projectId: string;
}

export function parseSentryDsnUrl(url: string): ParsedSentryUrl | null {
  try {
    const u = new URL(url);
    const publicKey = u.username;
    if (!publicKey) return null;
    const projectId = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!projectId) return null;
    return {
      protocol: u.protocol.replace(":", ""),
      publicKey,
      host: u.hostname,
      port: u.port,
      projectId,
    };
  } catch {
    return null;
  }
}

export function buildSentryDsnUrl(opts: {
  publicKey: string;
  host: string;
  projectId: string;
  protocol?: string;
}): string {
  const proto = opts.protocol ?? "https";
  return `${proto}://${opts.publicKey}@${opts.host}/${opts.projectId}`;
}

// Our v0 SDK uses the simpler bare DSN: `agnt_<projectId>_<token>`.
// We also expose helpers to convert between formats so we can adopt Sentry SDKs later.

export function dsnToSentryUrl(opts: { dsnRaw: string; host: string; protocol?: string }): string | null {
  // Expected: agnt_<projectId>.<token>
  const parts = opts.dsnRaw.match(/^agnt_([A-Za-z0-9-]+)\.(.+)$/);
  if (!parts) return null;
  const [, projectId, token] = parts;
  if (!projectId || !token) return null;
  return buildSentryDsnUrl({ publicKey: token, host: opts.host, projectId, protocol: opts.protocol });
}
