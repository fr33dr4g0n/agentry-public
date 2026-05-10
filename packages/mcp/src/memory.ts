// Local agent memory: a markdown file in the customer's repo at
// `<local_path>/agentry_memory.md`. Each case gets a section the agent can
// upsert; the file is grep-able, git-versionable, and human-editable.
//
// Why a local file instead of a server table:
//   - Survives even if agentry's server data is lost
//   - Grep-able with the agent's existing Read/Grep/Glob tools — no extra MCP needed for read
//   - Git-versioned with the customer's code (commit or .gitignore is their call)
//   - The customer can edit it directly; the agent will see those edits
//   - No server-side schema for what is fundamentally tacit knowledge

import * as fs from "node:fs";
import * as path from "node:path";

export const MEMORY_FILENAME = "agentry_memory.md";

const HEADER = `# Agentry memory

Notes the agent has accumulated investigating cases. Safe to commit (no secrets here).

Each \`## Case <id>\` section is upserted by \`agentry_remember\`. The agent reads
this file directly with its built-in file tools when investigating a similar case.

---
`;

export interface RememberInput {
  case_id: string;
  /** Short markdown body — what was learned. */
  summary: string;
  /** Optional structured fields surfaced as bullets. */
  fingerprint?: string;
  status?: string;
  error_type?: string;
  pr_url?: string;
  watch_for?: string;
  tags?: string[];
}

export interface RememberResult {
  ok: boolean;
  file_path: string;
  action: "created" | "appended" | "updated";
  next_action: string;
}

export function getMemoryPath(localPath: string | null | undefined): string | null {
  if (!localPath) return null;
  return path.join(localPath, MEMORY_FILENAME);
}

export function ensureMemoryFile(filePath: string): "created" | "exists" {
  if (fs.existsSync(filePath)) return "exists";
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, HEADER, "utf8");
  return "created";
}

function buildSection(input: RememberInput): string {
  const ts = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`## Case ${input.case_id}`);
  if (input.error_type) lines.push(`- **Error type**: ${input.error_type}`);
  if (input.fingerprint) lines.push(`- **Fingerprint**: \`${input.fingerprint}\``);
  if (input.status) lines.push(`- **Status**: ${input.status}`);
  lines.push(`- **Last touched**: ${ts}`);
  if (input.pr_url) lines.push(`- **PR**: ${input.pr_url}`);
  if (input.tags && input.tags.length > 0) {
    lines.push(`- **Tags**: ${input.tags.map((t) => "`" + t + "`").join(", ")}`);
  }
  lines.push("");
  lines.push(input.summary.trim());
  if (input.watch_for) {
    lines.push("");
    lines.push(`**Watch for:** ${input.watch_for.trim()}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function upsertCaseSection(
  filePath: string,
  input: RememberInput,
): "created" | "appended" | "updated" {
  const initState = ensureMemoryFile(filePath);
  const existing = fs.readFileSync(filePath, "utf8");
  const sectionHeader = `## Case ${input.case_id}`;

  // Find existing section start.
  const headerIdx = existing.indexOf(sectionHeader);
  if (headerIdx === -1) {
    // Append a new section.
    const newSection = buildSection(input);
    const sep = existing.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(filePath, `${existing}${sep}\n${newSection}\n`, "utf8");
    return initState === "created" ? "created" : "appended";
  }

  // Find next section header (## Case ...) or end of file.
  const after = existing.slice(headerIdx + sectionHeader.length);
  const nextSectionRel = after.search(/\n## Case /);
  const sectionEnd =
    nextSectionRel === -1
      ? existing.length
      : headerIdx + sectionHeader.length + nextSectionRel + 1; // +1 to keep the blank line before next section

  const before = existing.slice(0, headerIdx);
  const afterSection = existing.slice(sectionEnd);
  const replaced = `${before}${buildSection(input)}\n${afterSection.trimStart()}`;
  fs.writeFileSync(filePath, replaced, "utf8");
  return "updated";
}

export function readCaseSection(filePath: string, caseId: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf8");
  const header = `## Case ${caseId}`;
  const idx = text.indexOf(header);
  if (idx === -1) return null;
  const after = text.slice(idx);
  const nextRel = after.slice(header.length).search(/\n## Case /);
  return nextRel === -1 ? after : after.slice(0, header.length + nextRel + 1);
}
