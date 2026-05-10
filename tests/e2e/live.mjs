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

  // 2. Auth — uses the test-login backdoor; production flow is GitHub device.
  console.log("\n[auth]");
  let aliceKey, aliceUserId;
  {
    const r = await http("POST", "/v1/auth/_test/login", { body: { email: userA } });
    expect(r.status, 200, "test-login 200");
    if (r.json?.api_key?.startsWith("agk_")) ok("api_key prefix agk_");
    else bad("api_key bad shape", r.json);
    aliceKey = r.json.api_key;
    aliceUserId = r.json.user_id;
    if (r.json?.github?.username) ok(`github username surfaced: ${r.json.github.username}`);
    else bad("github metadata missing", r.json);
  }
  {
    const r = await http("POST", "/v1/auth/_test/login", { body: { email: userA } });
    expect(r.status, 200, "test-login-twice 200");
    if (r.json?.user_id === aliceUserId) ok("same email -> same user_id");
    else bad("user_id mismatch on re-login", { first: aliceUserId, second: r.json?.user_id });
    if (r.json?.api_key !== aliceKey) ok("re-login mints new key");
    else bad("re-login returned same key", null);
  }
  {
    // Device flow start should reach GitHub and either succeed or fail predictably.
    const r = await http("POST", "/v1/auth/device", { body: {} });
    if (r.status === 200 && r.json?.user_code) ok(`github device flow start ok (user_code: ${r.json.user_code})`);
    else bad("device flow start unexpected", { status: r.status, json: r.json });
  }
  {
    // Device poll without device_code is a 400.
    const r = await http("POST", "/v1/auth/device/poll", { body: {} });
    expect(r.status, 400, "device poll empty body -> 400");
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
    const r = await http("POST", "/v1/auth/_test/login", { body: { email: userB } });
    bobKey = r.json.api_key;
  }

  // Make bobKey available to later sections (recipes tenancy check)
  globalThis.__bobKey = bobKey;
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

  // 7.2 User identification
  console.log("\n[user identification]");
  {
    // Ingest events with user.id/user.email
    const fp1 = `usertest-${Date.now()}-A`;
    for (let i = 0; i < 3; i++) {
      await http("POST", `/v1/store/${projId}/`, {
        headers: { authorization: `Bearer ${projDsn}` },
        body: {
          user: { id: "u_alice", email: "alice@example.com" },
          exception: { values: [{ type: fp1, value: "user-test",
            stacktrace: { frames: [{ filename: `src/${fp1}.ts`, function: "fn", lineno: 1 }] } }] },
        },
      });
    }
    await http("POST", `/v1/store/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: {
        user: { id: "u_bob", email: "bob@example.com" },
        exception: { values: [{ type: fp1, value: "user-test",
          stacktrace: { frames: [{ filename: `src/${fp1}.ts`, function: "fn", lineno: 1 }] } }] },
      },
    });
    ok("ingested 4 events across 2 users");

    // List the case → has affected_users
    const list = await http("GET", `/v1/projects/${projId}/cases?status=open&q=${encodeURIComponent(fp1)}`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    const userCase = list.json?.cases?.[0];
    if (userCase) {
      const detail = await http("GET", `/v1/cases/${userCase.id}`, {
        headers: { authorization: `Bearer ${aliceKey}` },
      });
      if (detail.json?.affected_users?.count === 2) ok("affected_users.count=2 in case detail");
      else bad("affected_users wrong count", detail.json?.affected_users);
      const sampleIds = (detail.json?.affected_users?.sample ?? []).map((s) => s.user_id).sort();
      if (sampleIds.includes("u_alice") && sampleIds.includes("u_bob")) ok("sample includes both users");
      else bad("sample missing users", sampleIds);

      // /v1/cases/:id/users
      const u = await http("GET", `/v1/cases/${userCase.id}/users`, {
        headers: { authorization: `Bearer ${aliceKey}` },
      });
      expect(u.status, 200, "GET /cases/:id/users 200");
      if (u.json?.users?.length === 2) ok("/cases/:id/users returns 2");
      else bad("users endpoint wrong count", u.json);
    } else bad("case not found for user-test fingerprint", list.json);
  }
  {
    // /v1/projects/:id/users
    const r = await http("GET", `/v1/projects/${projId}/users?days=7`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(r.status, 200, "GET /projects/:id/users 200");
    if (typeof r.json?.unique_users === "number" && r.json.unique_users >= 2)
      ok(`unique_users=${r.json.unique_users}`);
    else bad("unique_users wrong", r.json);
  }
  {
    // top_users_by_errors recipe
    const r = await http("POST", `/v1/projects/${projId}/recipes/top_users_by_errors/run`, {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: { params: { days: 7, limit: 10 } },
    });
    expect(r.status, 200, "run top_users_by_errors 200");
    if (Array.isArray(r.json?.rows) && r.json.rows.length >= 2) ok(`top_users_by_errors returned ${r.json.rows.length}`);
    else bad("top_users_by_errors empty", r.json);
  }
  {
    // unique_users_24h recipe
    const r = await http("POST", `/v1/projects/${projId}/recipes/unique_users_24h/run`, {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: {},
    });
    expect(r.status, 200, "run unique_users_24h 200");
    if ((r.json?.rows?.[0]?.unique_users ?? 0) >= 2) ok(`unique_users_24h returned ${r.json.rows[0].unique_users}`);
    else bad("unique_users_24h count wrong", r.json);
  }

  // 7.25 Project health
  console.log("\n[project health]");
  {
    const r = await http("GET", `/v1/projects/${projId}/health`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(r.status, 200, "GET /health 200");
    if (typeof r.json?.last_event_received_at === "number" && r.json.last_event_received_at > 0)
      ok("last_event_received_at populated");
    else bad("last_event_received_at missing", r.json);
    if (r.json?.usage_this_month?.errors?.cap === 5000) ok("free-tier caps surfaced");
    else bad("caps missing", r.json?.usage_this_month);
    if (typeof r.json?.events_last_hour === "number") ok(`events_last_hour=${r.json.events_last_hour}`);
    else bad("events_last_hour missing", r.json);
  }

  // 7.27 Case search/filter
  console.log("\n[case search]");
  {
    // Filter by deploy_sha (we set last_deploy_sha when ingesting earlier)
    const r = await http("GET", `/v1/projects/${projId}/cases?status=open&q=Type`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(r.status, 200, "filter by q 200");
    if (Array.isArray(r.json?.cases)) ok(`q=Type matched ${r.json.cases.length} cases`);
    else bad("filter q broken", r.json);
  }
  {
    const r = await http("GET", `/v1/projects/${projId}/cases?since=1`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(r.status, 200, "filter by since 200");
  }

  // 7.28 Breadcrumbs in case detail
  console.log("\n[breadcrumbs]");
  {
    // Ingest an event with breadcrumbs
    const ev = {
      exception: { values: [{ type: "BreadcrumbError", value: "with crumbs",
        stacktrace: { frames: [{ filename: "src/breadcrumb.ts", function: "fn", lineno: 1 }] } }] },
      breadcrumbs: { values: [
        { ts: 1, type: "click", message: "Sign up clicked" },
        { ts: 2, type: "navigation", message: "/checkout" },
      ] },
    };
    const ing = await http("POST", `/v1/store/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: ev,
    });
    expect(ing.status, 200, "ingest with breadcrumbs 200");
    const detail = await http("GET", `/v1/cases/${ing.json.case_id}`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(detail.status, 200, "get case 200");
    const re = detail.json?.recent_events?.[0];
    if (re?.breadcrumbs?.values?.length === 2) ok("breadcrumbs surfaced in case detail");
    else bad("breadcrumbs missing or wrong shape", re);
  }

  // 7.3 Webhooks — register + fire-on-case-create + list + delete
  console.log("\n[webhooks]");
  // Spin up a tiny in-process receiver to verify signed delivery.
  const { createServer } = await import("node:http");
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  let received = [];
  const recvServer = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      let buf = "";
      req.on("data", (chunk) => { buf += chunk; });
      req.on("end", () => {
        received.push({ body: buf, sig: req.headers["x-agentry-signature"], event: req.headers["x-agentry-event"] });
        res.statusCode = 200;
        res.end("ok");
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const recvPort = recvServer.address().port;
  const recvUrl = `http://127.0.0.1:${recvPort}/`;

  let webhookId, signingSecret;
  {
    const r = await http("POST", `/v1/projects/${projId}/webhooks`, {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: { url: recvUrl, events: ["case.created"], description: "live e2e test" },
    });
    if (r.status === 200 && r.json?.signing_secret?.startsWith("whsec_")) {
      ok("webhook registered with whsec_ secret");
      webhookId = r.json.id;
      signingSecret = r.json.signing_secret;
    } else if (r.status === 500 && /AGENTRY_TOKEN_ENC_KEY/.test(JSON.stringify(r.json))) {
      ok("webhook registration correctly requires AGENTRY_TOKEN_ENC_KEY (not configured locally)");
      // Skip the rest of this section — local dev doesn't have the key.
      recvServer.close();
    } else {
      bad("webhook register unexpected", { status: r.status, json: r.json });
      recvServer.close();
    }
  }

  if (webhookId) {
    // Trigger a NEW case via /v1/log/ — should fire the webhook.
    const fp = `e2e-webhook-${Date.now()}`;
    const r = await http("POST", `/v1/log/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: { exception: { values: [{ type: fp, value: "webhook-trigger",
        stacktrace: { frames: [{ filename: `src/${fp}.ts`, function: "fn", lineno: 1 }] } }] } },
    });
    expect(r.status, 200, "webhook-trigger ingest 200");

    // Wait briefly for waitUntil delivery.
    await new Promise((res) => setTimeout(res, 500));

    if (received.length >= 1) ok(`webhook receiver got ${received.length} delivery`);
    else bad("webhook delivery missing", null);

    if (received[0]?.sig) {
      const m = received[0].sig.match(/v1=([0-9a-f]+)/);
      if (m && m[1]) {
        const expected = createHmac("sha256", signingSecret).update(received[0].body).digest("hex");
        const a = Buffer.from(expected, "hex");
        const b = Buffer.from(m[1], "hex");
        if (a.length === b.length && timingSafeEqual(a, b)) ok("HMAC signature verifies with stored secret");
        else bad("HMAC signature mismatch", { expected, got: m[1] });
      } else bad("signature header malformed", received[0].sig);
    } else bad("no signature header", null);

    if (received[0]?.body) {
      try {
        const parsed = JSON.parse(received[0].body);
        if (parsed.event === "case.created") ok("body event=case.created");
        else bad("body event wrong", parsed.event);
      } catch (e) { bad("body not JSON", e); }
    }

    // Test endpoint
    received = [];
    const t = await http("POST", `/v1/projects/${projId}/webhooks/${webhookId}/test`, {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: {},
    });
    expect(t.status, 200, "test webhook 200");
    await new Promise((res) => setTimeout(res, 500));
    if (received.length >= 1) ok("test fire delivered synthetic event");
    else bad("test fire delivered nothing", null);

    // List shows last_status=200
    const ls = await http("GET", `/v1/projects/${projId}/webhooks`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    const found = ls.json?.webhooks?.find?.((w) => w.id === webhookId);
    if (found?.last_status === 200) ok(`list shows last_status=200`);
    else bad("last_status not 200", found);

    // Delete
    const del = await http("DELETE", `/v1/projects/${projId}/webhooks/${webhookId}`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(del.status, 200, "delete webhook 200");

    recvServer.close();
  }

  // 7.4 CORS preflight (browser SDK)
  console.log("\n[cors]");
  {
    const r = await fetch(`${BASE}/v1/store/anything/`, {
      method: "OPTIONS",
      headers: {
        origin: "https://my-app.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    if ([200, 204].includes(r.status)) ok(`OPTIONS preflight on /v1/store ${r.status}`);
    else bad("preflight wrong status", r.status);
    if (r.headers.get("access-control-allow-origin") === "*") ok("ACAO=* on /v1/store preflight");
    else bad("missing ACAO=*", r.headers.get("access-control-allow-origin"));
  }
  {
    const r = await fetch(`${BASE}/v1/track/anything/`, {
      method: "OPTIONS",
      headers: {
        origin: "https://my-app.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization",
      },
    });
    if (r.headers.get("access-control-allow-origin") === "*") ok("ACAO=* on /v1/track preflight");
    else bad("missing ACAO=* on track", null);
    const allowedHeaders = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    if (allowedHeaders.includes("authorization")) ok("authorization allowed on track");
    else bad("authorization not allowed", allowedHeaders);
  }
  {
    // Real browser-shaped POST (with Origin) should still work and echo CORS headers
    const r = await fetch(`${BASE}/v1/store/${projId}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${projDsn}`,
        origin: "https://my-app.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        platform: "javascript",
        exception: { values: [{ type: "BrowserOriginError", value: "from cors check",
          stacktrace: { frames: [{ filename: "https://my-app.test/main.js", function: "fn", lineno: 1 }] } }] },
      }),
    });
    if (r.status === 200) ok("real browser-origin POST returns 200");
    else bad("browser-origin POST failed", r.status);
    if (r.headers.get("access-control-allow-origin") === "*") ok("ACAO=* on real POST");
    else bad("ACAO missing on real POST", null);
  }

  // 7.5 Install guide
  console.log("\n[install guide]");
  {
    const r = await http("GET", "/v1/install/guide?framework=node");
    expect(r.status, 200, "GET install/guide 200");
    if (Array.isArray(r.json?.steps) && r.json.steps.length >= 5) ok(`guide has ${r.json.steps.length} steps`);
    else bad("guide steps missing", r.json);
    const verifyStep = r.json?.steps?.find?.((s) => s.id === "verify_install");
    if (verifyStep) ok("verify_install step present");
    else bad("verify_install step missing", null);
    if (Array.isArray(r.json?.signal_health_principles) && r.json.signal_health_principles.length > 0)
      ok("signal_health_principles populated");
    else bad("signal_health_principles missing", null);
  }
  {
    const r = await http("GET", "/v1/install/guide?framework=express");
    expect(r.status, 200, "GET install/guide express 200");
    const expressMw = r.json?.steps?.find?.((s) => s.id === "express_error_middleware");
    if (expressMw) ok("express middleware step included for express framework");
    else bad("express middleware step missing", null);
  }
  {
    const r = await http("GET", "/v1/install/guide?framework=node&signal_types=errors,deploys");
    expect(r.status, 200, "GET install/guide signal filter 200");
    const hasAnalyticsStep = r.json?.steps?.some?.((s) => s.id === "track_signup_completed");
    if (!hasAnalyticsStep) ok("analytics steps filtered out");
    else bad("analytics step leaked through filter", null);
  }
  {
    // Browser-target install guide
    const r = await http("GET", "/v1/install/guide?framework=react");
    expect(r.status, 200, "GET install/guide react 200");
    const hasReactBoundary = r.json?.steps?.some?.((s) => s.id === "react_error_boundary");
    if (hasReactBoundary) ok("react ErrorBoundary step in client guide");
    else bad("react ErrorBoundary step missing", null);
    const hasDeploy = r.json?.steps?.some?.((s) => s.id === "fire_deploy_event_from_ci");
    if (!hasDeploy) ok("deploy step correctly omitted from client guide");
    else bad("deploy step leaked into client guide", null);
    const hasInstallSdk = r.json?.steps?.find?.((s) => s.id === "install_sdk");
    if (hasInstallSdk?.command?.includes("@agentry/browser")) ok("client guide installs @agentry/browser");
    else bad("client guide doesn't install browser SDK", hasInstallSdk?.command);
  }
  {
    // Browser SDK install snippet
    const r = await http("GET", "/v1/install/sdk/browser");
    expect(r.status, 200, "GET install/sdk/browser 200");
    if (r.json?.code?.includes("@agentry/browser")) ok("browser snippet imports @agentry/browser");
    else bad("browser snippet wrong import", null);
  }

  // 7.6 Deploys
  console.log("\n[deploys]");
  let deployId;
  {
    const r = await http("POST", `/v1/deploys/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: { sha: "deadbeef1234", branch: "main", environment: "production", message: "first deploy" },
    });
    expect(r.status, 200, "deploy ingest 200");
    if (r.json?.id) ok("deploy id returned");
    else bad("deploy id missing", r.json);
    deployId = r.json?.id;
  }
  {
    const r = await http("GET", `/v1/projects/${projId}/deploys?limit=10`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(r.status, 200, "list deploys 200");
    const found = r.json?.deploys?.find?.((d) => d.id === deployId);
    if (found) ok("deploy appears in list");
    else bad("deploy missing from list", r.json);
  }
  {
    // Wrong DSN should be rejected.
    const r = await http("POST", `/v1/deploys/${projId}/`, {
      headers: { authorization: `Bearer agnt_wrong.token` },
      body: { sha: "x" },
    });
    expect(r.status, 401, "deploy wrong DSN -> 401");
  }
  {
    // After a deploy, the case detail should surface it.
    // Trigger a fresh fingerprint then read the case.
    const ev = {
      exception: { values: [{ type: "DeployTestError", value: "post-deploy",
        stacktrace: { frames: [{ filename: "src/postdeploy.ts", function: "fn", lineno: 1, in_app: true }] } }] },
    };
    const ing = await http("POST", `/v1/store/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: ev,
    });
    expect(ing.status, 200, "ingest post-deploy 200");
    if (ing.json?.case_id) {
      const detail = await http("GET", `/v1/cases/${ing.json.case_id}`, {
        headers: { authorization: `Bearer ${aliceKey}` },
      });
      expect(detail.status, 200, "fresh case detail 200");
      if (Array.isArray(detail.json?.recent_deploys) && detail.json.recent_deploys.length > 0)
        ok("recent_deploys surfaces in case detail");
      else bad("recent_deploys missing from case", detail.json);
    }
  }

  // 7.55 Suggested next-steps (the post-install conversational menu)
  console.log("\n[next-steps]");
  {
    const r = await http("GET", `/v1/projects/${projId}/next-steps`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(r.status, 200, "GET next-steps 200");
    if (r.json?.project_state) ok("project_state returned");
    else bad("project_state missing", r.json);
    if (Array.isArray(r.json?.suggestions) && r.json.suggestions.length >= 1)
      ok(`${r.json.suggestions.length} suggestions returned`);
    else bad("no suggestions", r.json);
    // The error-monitoring suggestion requires has_cases which we have (resolved cases too count)
    const errorsDashboard = r.json?.suggestions?.find?.(
      (s) => s.id === "build_error_dashboard",
    );
    if (errorsDashboard?.prompt_template?.length > 50)
      ok("build_error_dashboard surfaced with prompt_template");
    else bad("build_error_dashboard missing or empty", errorsDashboard);
  }
  {
    // Fresh project (no cases / no deploys) should get fewer suggestions
    const fresh = await http("POST", "/v1/projects", {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: { name: "empty-state-test" },
    });
    const freshProj = fresh.json;
    const r = await http("GET", `/v1/projects/${freshProj.id}/next-steps`, {
      headers: { authorization: `Bearer ${aliceKey}` },
    });
    expect(r.status, 200, "fresh project next-steps 200");
    if (Array.isArray(r.json?.suggestions))
      ok(`fresh project: ${r.json.suggestions.length} suggestions (state-aware filtered)`);
    else bad("suggestions missing on fresh project", r.json);
  }

  // 7.6 Recipes (the agent's no-dashboard query surface)
  console.log("\n[recipes]");
  {
    const r = await http("GET", "/v1/recipes");
    expect(r.status, 200, "GET /v1/recipes 200");
    if (r.json?.count >= 10) ok(`${r.json.count} recipes available`);
    else bad("expected >=10 recipes", r.json?.count);
    if (Array.isArray(r.json?.categories) && r.json.categories.includes("funnels"))
      ok("funnels category present");
    else bad("funnels category missing", r.json?.categories);
  }
  {
    const r = await http("GET", "/v1/recipes/funnel_3_step");
    expect(r.status, 200, "GET specific recipe 200");
    if (r.json?.query?.includes("{{step1}}")) ok("recipe template has placeholders");
    else bad("recipe missing placeholders", r.json);
  }
  {
    // Cases-backend recipe (no PostHog needed) → should run against agentry's DB
    const r = await http("POST", `/v1/projects/${projId}/recipes/open_cases_top/run`, {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: { params: { limit: 5 } },
    });
    expect(r.status, 200, "run open_cases_top 200");
    if (Array.isArray(r.json?.rows)) ok(`open_cases_top returned ${r.json.rows.length} rows`);
    else bad("rows missing", r.json);
    if (r.json?.render_hint?.type === "table") ok("render_hint=table");
    else bad("render_hint missing/wrong", r.json?.render_hint);
  }
  {
    // Analytics recipe — should 503 because PostHog isn't configured locally
    const r = await http("POST", `/v1/projects/${projId}/recipes/active_users_daily/run`, {
      headers: { authorization: `Bearer ${aliceKey}` },
      body: { params: { days: 7 } },
    });
    if ([500, 502, 503].includes(r.status))
      ok(`analytics recipe 5xx without PostHog (got ${r.status})`);
    else bad("expected 5xx for analytics-without-PostHog", r.status);
  }
  {
    // Tenancy: Bob can't run a recipe on Alice's project
    const r = await http("POST", `/v1/projects/${projId}/recipes/open_cases_top/run`, {
      headers: { authorization: `Bearer ${bobKey ?? "agk_invalid"}` },
      body: { params: {} },
    });
    expect([401, 403].includes(r.status), true, `cross-tenant recipe -> 4xx (got ${r.status})`);
  }
  {
    const r = await http("GET", "/v1/docs/query");
    expect(r.status, 200, "GET /v1/docs/query 200");
    const ct = r.headers.get("content-type") ?? "";
    if (ct.includes("text/markdown")) ok("docs served as markdown");
    else bad("docs wrong content-type", ct);
    if ((r.text ?? "").includes("HogQL")) ok("docs mention HogQL");
    else bad("docs missing HogQL primer", null);
  }

  // 7.65 Unified /v1/log/ endpoint — auto-detects what kind of signal it is
  console.log("\n[/v1/log/ unified endpoint]");
  {
    // Error shape (Sentry-like)
    const r = await http("POST", `/v1/log/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: { exception: { values: [{ type: "LogTestError", value: "from /v1/log",
        stacktrace: { frames: [{ filename: "src/log_test.ts", function: "fn", lineno: 1 }] } }] } },
    });
    expect(r.status, 200, "log(error envelope) -> 200");
    expect(r.json?.detected_kind, "error", "detected_kind=error");
    if (r.json?.case_id) ok("case_id returned for error log");
    else bad("case_id missing", r.json);
  }
  {
    // Plain {name, message, stack} shape (e.g. raw Error from Python via curl)
    const r = await http("POST", `/v1/log/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: { name: "PythonStyleError", message: "from python", stack: "  at fn (file.py:1:1)" },
    });
    expect(r.status, 200, "log({name,message,stack}) -> 200");
    expect(r.json?.detected_kind, "error", "detected_kind=error for plain shape");
  }
  {
    // Deploy shape — has sha, no event
    const r = await http("POST", `/v1/log/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: { sha: "logtest-sha", branch: "main", environment: "production" },
    });
    expect(r.status, 200, "log({sha}) -> 200");
    expect(r.json?.detected_kind, "deploy", "detected_kind=deploy");
    if (r.json?.deploy_id) ok("deploy_id returned");
    else bad("deploy_id missing", r.json);
  }
  {
    // Analytics event — should 503 since PostHog not configured locally
    const r = await http("POST", `/v1/log/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: { event: "log_endpoint_test" },
    });
    if ([502, 503].includes(r.status)) ok(`log({event}) routed to analytics, status ${r.status} (PostHog unconfigured)`);
    else bad("event log unexpected status", { status: r.status, json: r.json });
    expect(r.json?.detected_kind, "event", "detected_kind=event");
  }
  {
    // Explicit kind wins over auto-detect
    const r = await http("POST", `/v1/log/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: { kind: "deploy", sha: "explicit-sha" },
    });
    expect(r.json?.detected_kind, "deploy", "explicit kind=deploy honored");
  }
  {
    // Wrong DSN should be rejected
    const r = await http("POST", `/v1/log/${projId}/`, {
      headers: { authorization: `Bearer agnt_wrong.token` },
      body: { sha: "x" },
    });
    expect(r.status, 401, "log wrong DSN -> 401");
  }

  // 7.66 Multi-language install guides
  console.log("\n[multi-language guides]");
  for (const fw of ["python", "ruby", "go", "php", "java", "dotnet", "rust", "elixir", "curl"]) {
    const r = await http("GET", `/v1/install/guide?framework=${fw}`);
    expect(r.status, 200, `GET install/guide ${fw} 200`);
    if (Array.isArray(r.json?.steps) && r.json.steps.length >= 4) ok(`${fw} guide has steps`);
    else bad(`${fw} guide missing steps`, r.json);
    const helper = r.json?.steps?.find?.((s) => s.id === "drop_in_helper");
    if (helper?.code?.length > 100) ok(`${fw} drop-in helper present`);
    else bad(`${fw} drop-in helper missing`, helper);
  }

  // 7.7 Analytics — should 503 because PostHog isn't configured in dev
  console.log("\n[analytics — PostHog unconfigured]");
  {
    const r = await http("POST", `/v1/track/${projId}/`, {
      headers: { authorization: `Bearer ${projDsn}` },
      body: { event: "test", distinct_id: "u1", properties: { ok: true } },
    });
    expect(r.status, 503, "track without PostHog config -> 503");
    expect(r.json?.error?.code, "analytics_not_configured", "analytics_not_configured code");
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
