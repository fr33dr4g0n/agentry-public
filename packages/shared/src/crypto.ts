// Web Crypto helpers — compatible with Cloudflare Workers and Node 20+.

import { base64url, shortId } from "./ids.js";

const enc = new TextEncoder();

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? enc.encode(input) : input;
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(buf));
}

export async function sha1Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? enc.encode(input) : input;
  const buf = await globalThis.crypto.subtle.digest("SHA-1", data);
  return toHex(new Uint8Array(buf));
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// API keys: prefix `agk_` + 32 random base64url chars
// DSNs: format `agnt_<projectId>_<token>` — token is 32 base64url chars
// Stored as sha256 hash; raw value shown to user once.

export const API_KEY_PREFIX = "agk_";
export const DSN_PREFIX = "agnt_";

export interface MintedKey {
  raw: string;
  hash: string;
  prefix: string; // first 12 chars including the prefix, used for display + DB lookup
}

export async function mintApiKey(): Promise<MintedKey> {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const tail = base64url(bytes);
  const raw = `${API_KEY_PREFIX}${tail}`;
  const hash = await sha256Hex(raw);
  return { raw, hash, prefix: raw.slice(0, 12) };
}

export interface MintedDsn {
  raw: string;
  hash: string;
  prefix: string;
  token: string;
}

export async function mintDsn(projectId: string): Promise<MintedDsn> {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  // `.` separator: project ids are uuidv7 with `-`; tokens are base64url with `-_`. Neither contains `.`.
  const raw = `${DSN_PREFIX}${projectId}.${token}`;
  const hash = await sha256Hex(raw);
  return { raw, hash, prefix: raw.slice(0, 16), token };
}

export function parseDsn(dsn: string): { projectId: string; token: string } | null {
  if (!dsn.startsWith(DSN_PREFIX)) return null;
  const rest = dsn.slice(DSN_PREFIX.length);
  const sep = rest.indexOf(".");
  if (sep === -1) return null;
  const projectId = rest.slice(0, sep);
  const token = rest.slice(sep + 1);
  if (!projectId || !token) return null;
  return { projectId, token };
}

// Suppress unused warning at compile-time
void shortId;
