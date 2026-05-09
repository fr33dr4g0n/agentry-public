// Local config persistence for the MCP server.
// Stored at ~/.agentry/config.json (or AGENTRY_CONFIG_PATH if set).
// Atomic write (tmp + rename), chmod 600 to keep API keys off the prying eyes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentryConfig } from "@agentry/shared";

const DEFAULT_SERVER_URL = "https://agentry-api.henrikh.workers.dev";

export function getConfigPath(): string {
  if (process.env.AGENTRY_CONFIG_PATH) return process.env.AGENTRY_CONFIG_PATH;
  return path.join(os.homedir(), ".agentry", "config.json");
}

export function defaultConfig(): AgentryConfig {
  return {
    server_url: process.env.AGENTRY_SERVER_URL ?? DEFAULT_SERVER_URL,
    api_key: null,
    default_project_id: null,
    projects: {},
  };
}

export function loadConfig(): AgentryConfig {
  const file = getConfigPath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentryConfig>;
    // Merge with defaults — gracefully handle older config shapes.
    return {
      server_url: parsed.server_url ?? defaultConfig().server_url,
      api_key: parsed.api_key ?? null,
      default_project_id: parsed.default_project_id ?? null,
      projects: parsed.projects ?? {},
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return defaultConfig();
    // Corrupt config — refuse rather than silently overwrite.
    throw new Error(
      `Failed to read config at ${file}: ${e.message}. ` +
        `Move the file aside if you want a fresh start.`
    );
  }
}

export function saveConfig(cfg: AgentryConfig): void {
  const file = getConfigPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // Best-effort restrict the dir too. Users on Windows just get the default.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore — non-fatal, especially on Windows / odd FS
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore — non-fatal on platforms that don't honor chmod
  }
}
