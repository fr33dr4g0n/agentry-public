#!/usr/bin/env node
// Live end-to-end test against a running wrangler dev (defaults to http://127.0.0.1:8787).
// Exercises: signup, key rotate, project create, ingest (3 shapes), list cases, get case,
// patch case, suppression, suppressed ingest, tenancy isolation, and bad-input edge cases.
// Each step prints a green ✓ or red × with a short diagnosis.

const BASE = process.env.AGENTRY_API ?? "http://127.0.0.1:8787";
const ts = Date.now();
const userA = `alice+${ts}@e2e.agentry.dev`;
const userB = `bob+${ts}@e2e.agentry.dev`;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) {
  pass++;
  console.log(`  ✓ ${name}`);
}
function bad(name, info) {
  fail++;
  failures.push({ name, info });
  console.log(`  × ${name}`);
  console.log(`     ${typeof info === "string" ? info : JSON.stringify(info)}`);
}

function expect(actual, expected, name) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(name);
  else bad(name, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

async function http(method, path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : opts.raw,
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  console.log(`\n→ live e2e against ${BASE}`);

  // 1. Discovery
  console.log("\n[discovery]");
  {
    const r = await http("GET", "/");
    expect(r.status, 200, "GET / 200");
    expect(r.json?.name, "agentry", "GET / .name");
  }
  {
    const r = await http("GET", "/llms.txt");
    expect(r.status, 200, "GET /llms.txt 200");
    if (r.text.includes("agentry")) ok("llms.txt mentions agentry");
    else bad("llms.txt missing brand", r.text.slice(0, 100));
  }
  {
    const r = await http("GET", "/v1/install/sdk/node");
    expect(r.status, 200, "GET install/node 200");
    if (r.json?.code?.includes("agentry.init")) ok("install snippet has init");
    else bad("install snippet missing init", r.json);
  }
  {
    const r = await http("GET", "/v1/does-not-exist");
    expect(r.status, 404, "unknown route 404");
    expect(r.json?.error?.code, "not_found", "404 has code=not_found");
  }

  // 2. Auth
  console.log("\n[auth]");
  let aliceKey, aliceUserId;
  {
    const r = await http("POST", "/v1/auth/signup", { body: { email: userA } });
    expect(r.status, 200, "signup 200");
    if (r.json?.api_key?.startsWith("agk_")) ok("api_key prefix agk_");
    else bad("api_key bad shape", r.json);
    aliceKey = r.json.api_key;
    aliceUserId = r.json.user_id;
  }
  {
    const r = await http("POST", "/v1/auth/signup", { body: { email: userA } });
    expect(r.status, 200, "signup-twice 200");
    if (r.json?.user_id === aliceUserId) ok("same email -> same user_id");
    else bad("user_id mismatch on re-signup", { first: aliceUserId, second: r.json?.user_id });
    if (r.json?.api_key !== aliceKey) ok("re-signup mints new key");
    else bad("re-signup returned same key", null);
  }
  {
    const r = await http("POST", "/v1/auth/signup", { body: { email: "not-an-email" } });
    expect(r.status, 400, "signup invalid email -> 400");
    expect(r.json?.error?.code, "invalid_payload", "invalid_payload code");
  }
  {
    const r = await http("POST", "/v1/auth/keys/rotate", { headers: { authorization: `Bearer ${aliceKey}` } });
    expect(r.status, 200, "rotate 200");
    if (r.json?.api_key && r.json.api_key !== aliceKey) ok("new key returned");
    else bad("rotate did not return new key", r.json);
    aliceKey = r.json.api_key;
  }
  {
    const r = await http("GET", "/v1/projects");
    expect(r.status, 401, "no-auth -> 401");
    expect(r.json?.error?.code, "unauthorized", "unauthorized code");
  }

  // 3. Project create
  console.log("\n[projects]");
  let projId, projDsn;
  {
    const r = await http("POST", "/v1/projects", {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: { name: "musicvideogenerator", repo_url: "https://github.com/me/mvg", local_path: "/tmp/mvg" },
    });
    expect(r.status, 200, "create project 200");
    if (r.json?.id && r.json?.dsn?.startsWith("agnt_")) ok("dsn returned");
    else bad("dsn missing", r.json);
    if (r.json?.install_snippet?.includes("agentry.init")) ok("install_snippet returned");
    else bad("install_snippet missing", r.json);
    projId = r.json.id;
    projDsn = r.json.dsn;
  }
  {
    const r = await http("GET", "/v1/projects", { headers: { authorization: `Bearer ${aliceKey}` } });
    expect(r.status, 200, "list projects 200");
    const found = r.json?.projects?.find?.((p) => p.id === projId);
    if (found) ok("project appears in list");
    else bad("project missing from list", r.json);
  }

  // 4. Ingest — sentry-shape with frames
  console.log("\n[ingest]");
  let firstCaseId;
  {
    const payload = {
      event_id: crypto.randomUUID(),
      timestamp: Date.now() / 1000,
      platform: "node",
      environment: "production",
      deploy_sha: "abcdef1234",
      level: "error",
      exception: {
        values: [{
          type: "TypeError",
          value: "Cannot read property 'name' of null",
          stacktrace: {
            frames: [
              { filename: "src/checkout.ts", function: "process", lineno: 42, in_app: true },
              { filename: "node_modules/express/lib/router/layer.js", function: "Layer.handle", lineno: 95, in_app: false },
            ],
          },
        }],
      },
    };
    const r = await http("POST", `/v1/store/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: payload,
    });
    expect(r.status, 200, "ingest sentry-shape 200");
    if (r.json?.case_id) ok("case_id returned");
    else bad("no case_id", r.json);
    if (r.json?.suppressed === false) ok("not suppressed");
    else bad("unexpected suppression", r.json);
    firstCaseId = r.json.case_id;
  }
  {
    // X-Sentry-Auth header
    const payload = { exception: { values: [{ type: "RangeError", value: "out of range",
      stacktrace: { frames: [{ filename: "src/util.ts", function: "calc", lineno: 10, in_app: true }] } }] } };
    const r = await http("POST", `/v1/store/${projId}/`, {
      headers: { "x-sentry-auth": `Sentry sentry_key=${projDsn}, sentry_version=7` },
      body: payload,
    });
    expect(r.status, 200, "ingest X-Sentry-Auth 200");
    if (r.json?.case_id && r.json.case_id !== firstCaseId) ok("different fingerprint -> new case");
    else bad("expected new case for different error", r.json);
  }
  {
    // Same fingerprint — should reuse case
    const payload = {
      deploy_sha: "newer-sha",
      exception: { values: [{ type: "TypeError", value: "Cannot read property 'name' of null",
        stacktrace: { frames: [{ filename: "src/checkout.ts", function: "process", lineno: 42, in_app: true }] } }] },
    };
    const r = await http("POST", `/v1/store/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: payload,
    });
    expect(r.status, 200, "ingest dup 200");
    if (r.json?.case_id === firstCaseId) ok("same fingerprint -> same case");
    else bad("expected same case", { got: r.json?.case_id, want: firstCaseId });
  }
  {
    // Bad DSN
    const r = await http("POST", `/v1/store/${projId}/`, {
      headers: { authorization: `Bearer agnt_wrong.token` },
      body: { exception: { values: [{ type: "X", value: "x" }] } },
    });
    expect(r.status, 401, "wrong DSN -> 401");
    expect(r.json?.error?.code, "invalid_dsn", "invalid_dsn code");
  }
  {
    // Malformed body
    const r = await http("POST", `/v1/store/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      raw: "{not-json",
    });
    expect(r.status, 400, "bad json -> 400");
    expect(r.json?.error?.code, "invalid_payload", "invalid_payload code");
  }
  {
    // 'throw "string"' shape (no frames, just message)
    const r = await http("POST", `/v1/store/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: { message: "🔥 plain string throw 🔥" },
    });
    expect(r.status, 200, "ingest message-only 200");
  }
  {
    // Huge stack
    const frames = Array.from({ length: 500 }, (_, i) => ({
      filename: `src/deep/file${i}.ts`, function: `fn${i}`, lineno: i, in_app: i < 50,
    }));
    const r = await http("POST", `/v1/store/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: { exception: { values: [{ type: "DeepError", value: "deep", stacktrace: { frames } }] } },
    });
    expect(r.status, 200, "ingest huge stack 200");
  }

  // 5. Cases listing + detail
  console.log("\n[cases]");
  let listedCaseId;
  {
    const r = await http("GET", `/v1/projects/${projId}/cases`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(r.status, 200, "list cases 200");
    if (Array.isArray(r.json?.cases) && r.json.cases.length >= 3) ok(`>=3 cases listed (got ${r.json.cases.length})`);
    else bad("expected >=3 cases", r.json);
    listedCaseId = r.json?.cases?.[0]?.id;
  }
  {
    const r = await http("GET", `/v1/cases/${firstCaseId}`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(r.status, 200, "get case 200");
    if (Array.isArray(r.json?.recent_events) && r.json.recent_events.length >= 2) ok("recent_events populated");
    else bad("recent_events missing", r.json);
    if (r.json?.local_path === "/tmp/mvg") ok("local_path surfaces in case");
    else bad("local_path missing", r.json);
    if (Array.isArray(r.json?.next_actions) && r.json.next_actions.length > 0) ok("next_actions populated");
    else bad("next_actions missing", r.json);
  }
  {
    // status filter
    const r = await http("GET", `/v1/projects/${projId}/cases?status=resolved`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(r.status, 200, "list resolved 200");
    expect(Array.isArray(r.json?.cases) ? r.json.cases.length : -1, 0, "no resolved cases yet");
  }
  {
    const r = await http("PATCH", `/v1/cases/${firstCaseId}`, {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: { status: "resolved", agent_summary: "Fixed in PR #42", pr_url: "https://github.com/me/mvg/pull/42" },
    });
    expect(r.status, 200, "patch case 200");
    expect(r.json?.status, "resolved", "case is resolved");
  }
  {
    const r = await http("POST", `/v1/cases/${firstCaseId}/runs`, {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: { case_id: firstCaseId, status: "pr_opened", pr_url: "https://github.com/me/mvg/pull/42", summary_md: "fix null check" },
    });
    expect(r.status, 200, "post agent run 200");
  }

  // 6. Suppressions + suppressed ingest
  console.log("\n[suppressions]");
  // Let's use the second case's fingerprint (the RangeError) — fetch it then suppress
  const listAgain = await http("GET", `/v1/projects/${projId}/cases?status=open`, {
    headers: { authorization: `Bearer ${aliceKey}` },
  });
  const rangeCase = listAgain.json?.cases?.find?.((c) => c.error_type === "RangeError");
  if (!rangeCase) {
    bad("setup: could not find RangeError case to suppress", listAgain.json);
  } else {
    const r = await http("POST", `/v1/projects/${projId}/suppressions`, {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: { fingerprint_pattern: rangeCase.fingerprint, action: "auto_ignore", reason: "noisy" },
    });
    expect(r.status, 200, "suppression created 200");
    // Now re-ingest the same RangeError; should suppress
    const payload = { exception: { values: [{ type: "RangeError", value: "out of range",
      stacktrace: { frames: [{ filename: "src/util.ts", function: "calc", lineno: 10, in_app: true }] } }] } };
    const r2 = await http("POST", `/v1/store/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: payload,
    });
    expect(r2.status, 202, "suppressed ingest -> 202");
    expect(r2.json?.suppressed, true, "suppressed=true");
  }

  // 7. Tenancy
  console.log("\n[tenancy]");
  let bobKey;
  {
    const r = await http("POST", "/v1/auth/signup", { body: { email: userB } });
    bobKey = r.json.api_key;
  }
  {
    const r = await http("GET", `/v1/cases/${firstCaseId}`, {
      headers: { authorization: `Bearer ${bobKey}` },
    });
    expect(r.status, 403, "user B reading user A's case -> 403");
    expect(r.json?.error?.code, "forbidden", "forbidden code");
  }
  {
    const r = await http("GET", `/v1/projects/${projId}/cases`, {
      headers: { authorization: `Bearer ${bobKey}` },
    });
    expect([401, 403, 404].includes(r.status), true, `user B listing user A's cases -> 4xx (got ${r.status})`);
  }

  // 8. Bad inputs / edges (don't 5xx)
  console.log("\n[robustness]");
  {
    const r = await http("POST", `/v1/store/nonexistent-project/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: { exception: { values: [{ type: "X", value: "x" }] } },
    });
    expect([401, 404].includes(r.status), true, `unknown project -> 4xx (got ${r.status})`);
  }
  {
    const r = await http("POST", "/v1/projects", {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: { name: "" },
    });
    expect(r.status, 400, "empty project name -> 400");
  }
  {
    const r = await http("PATCH", `/v1/cases/${firstCaseId}`, {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: {},
    });
    expect(r.status, 400, "patch with empty body -> 400");
  }
  {
    // Forward-compat: unknown extra fields should be accepted on ingest
    const r = await http("POST", `/v1/store/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: {
        exception: { values: [{ type: "OK", value: "future fields ok",
          stacktrace: { frames: [{ filename: "src/future.ts", function: "f", lineno: 1, in_app: true }] } }] },
        future_field_x: { whatever: true },
      },
    });
    expect(r.status, 200, "unknown extra fields -> 200");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log("  -", f.name);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("e2e crashed:", err);
  process.exit(2);
});
