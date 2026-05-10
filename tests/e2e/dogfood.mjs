#!/usr/bin/env node
// Dogfood: simulate the human path. Pretend to be a developer with the
// musicvideogenerator app, install the SDK, throw a real error, verify the
// case lands. Uses the API directly (no MCP) since the human will do the
// MCP step manually when they come back. This validates the end of the loop:
// app -> SDK -> ingest -> case visible.

import { agentry } from "@agentry/node";

const BASE = process.env.AGENTRY_API ?? "http://127.0.0.1:8787";
const ts = Date.now();
const email = `dogfood+${ts}@e2e.agentry.dev`;
const projectName = "musicvideogenerator";

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json };
}

console.log("\n→ dogfood as if a developer in musicvideogenerator");

// Step 1: log in via the test-login backdoor (production users go through
// GitHub device flow; the backdoor exists only when ENABLE_TEST_LOGIN=true).
console.log("\n[step 1] test-login");
const su = await api("POST", "/v1/auth/_test/login", { email });
if (su.status !== 200) { console.error("test-login failed:", su); process.exit(1); }
const apiKey = su.json.api_key;
console.log("  ✓ got api_key", apiKey.slice(0, 12) + "…");
console.log("  ✓ github user", su.json.github?.username);

// Step 2: create project
console.log("\n[step 2] create project");
const proj = await api("POST", "/v1/projects",
  { name: projectName, repo_url: "https://github.com/me/musicvideogenerator", local_path: "/Users/henrikh/Documents/code/musicvideogenerator" },
  { authorization: `Bearer ${apiKey}` });
if (proj.status !== 200) { console.error("project create failed:", proj); process.exit(1); }
const dsn = proj.json.dsn;
const projectId = proj.json.id;
console.log("  ✓ project created", projectId);
console.log("  ✓ DSN", dsn.slice(0, 20) + "…");

// Step 3: init SDK and capture a real error
console.log("\n[step 3] SDK init + capture");
agentry.init({ dsn, deploySha: "dogfood-" + ts.toString().slice(-6), environment: "dogfood", serverUrl: BASE });

// Throw and capture three different shapes
function generateMusicVideo(track) {
  if (!track || typeof track !== "object") {
    throw new TypeError("Cannot generate video: track is " + (track === null ? "null" : typeof track));
  }
  return track.id;
}

try { generateMusicVideo(null); }
catch (e) { agentry.capture(e, { tags: { component: "encoder" }, extra: { trackId: "tr_42" } }); console.log("  ✓ captured TypeError"); }

try { JSON.parse("{not-json"); }
catch (e) { agentry.capture(e, { tags: { component: "config-loader" } }); console.log("  ✓ captured SyntaxError"); }

agentry.capture("string thrown directly — no stack");
console.log("  ✓ captured string-throw");

const flushed = await agentry.flush(5000);
if (!flushed) { console.error("flush failed/timed out"); process.exit(1); }
console.log("  ✓ flush succeeded");

// Step 3.5: fire a deploy event via the unified /v1/log/ endpoint (the simplest path)
console.log("\n[step 3.5] deploy event via agentry.log()");
const ok = await agentry.log({
  sha: "dogfood-sha-" + ts.toString().slice(-6),
  branch: "main",
  environment: "dogfood",
  message: "synthetic dogfood deploy",
});
if (!ok) { console.error("agentry.log({sha:...}) failed"); process.exit(1); }
console.log("  ✓ deploy logged via agentry.log() (auto-detected as deploy)");

// Step 4: verify cases landed
console.log("\n[step 4] verify cases via API");
await new Promise((r) => setTimeout(r, 500));
const list = await api("GET", `/v1/projects/${projectId}/cases`,
  undefined,
  { authorization: `Bearer ${apiKey}` });
if (list.status !== 200) { console.error("list failed:", list); process.exit(1); }
const cases = list.json.cases ?? [];
console.log(`  ✓ ${cases.length} cases landed`);
if (cases.length < 3) {
  console.error("expected >= 3 cases, got", cases.length, list.json);
  process.exit(1);
}
for (const c of cases) {
  console.log(`    - ${c.error_type}: ${c.message.slice(0, 60)}${c.message.length > 60 ? "…" : ""}`);
}

// Step 5: read one case in detail (what the user's Claude Code will do)
console.log("\n[step 5] read first case in detail");
const detail = await api("GET", `/v1/cases/${cases[0].id}`, undefined, { authorization: `Bearer ${apiKey}` });
if (detail.status !== 200) { console.error("detail failed:", detail); process.exit(1); }
console.log("  ✓ recent_events:", detail.json.recent_events.length);
console.log("  ✓ local_path:", detail.json.local_path);
console.log("  ✓ next_actions[0]:", detail.json.next_actions[0]);

console.log(`\n✓ dogfood passed`);
console.log(`\nFor the human:`);
console.log(`  email used: ${email}`);
console.log(`  api_key: ${apiKey}`);
console.log(`  project: ${projectId}`);
console.log(`  dsn: ${dsn}`);

await agentry.close();
