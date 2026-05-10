// Hand-written install guide content. Returned by GET /v1/install/guide?framework=…
// The guide is meant to be consumed by the user's Claude Code session, which
// reads it, plans which steps apply to the user's codebase, executes them,
// then calls agentry_verify_install at the end.

export type Framework = "node" | "next" | "express";

export interface InstallGuideStep {
  id: string;
  title: string;
  why: string;
  action: "run" | "edit" | "verify" | "manual";
  file_hint?: string;
  command?: string;
  code?: string;
  validate: string;
}

export interface InstallGuide {
  framework: Framework;
  signal_types: string[];
  steps: InstallGuideStep[];
  pitfalls: string[];
  signal_health_principles: string[];
  next_action: string;
}

const SIGNAL_HEALTH_PRINCIPLES = [
  "Errors that don't error aren't useful: trigger a synthetic error after install and confirm it lands in agentry_list_cases.",
  "Analytics where events don't fire aren't useful: confirm at least one event from the real signup/checkout flow lands in PostHog within 24h.",
  "Deploys without timing aren't useful: tag deploy events with the actual deploy completion time, not the build start.",
  "If you can't see a signal in agentry within 60s of triggering it, it's not a slow pipeline — it's a broken install.",
];

const COMMON_PITFALLS = [
  "Don't call agentry.init() in client-side bundles (Next.js client components, browser code) — the DSN leaks. Use a server-only entrypoint.",
  "If you wrap fetch with retries, capture errors AFTER retries exhaust to avoid noisy duplicates.",
  "Set environment ('production' / 'staging') at init time so cases are filterable.",
  "Set deploySha to your actual git SHA at init — it's how cases get attributed to deploys.",
  "Track analytics events from the SERVER once the action completes, not from the browser before submission. Browser-only tracking misses ~30% of events to ad-blockers.",
];

function commonSteps(): InstallGuideStep[] {
  return [
    {
      id: "install_sdk",
      title: "Install the @agentry/node SDK",
      why: "Required for any error, analytics, or deploy capture.",
      action: "run",
      command: "npm install @agentry/node",
      validate: "package.json should list @agentry/node as a dependency.",
    },
    {
      id: "set_env_vars",
      title: "Set AGENTRY_DSN and GIT_SHA in the runtime environment",
      why: "DSN authenticates the SDK to agentry. GIT_SHA links each event to the deploy that emitted it.",
      action: "manual",
      file_hint: "Set in .env / Vercel env / Railway env / docker-compose / wherever your app reads env from at runtime.",
      validate:
        "process.env.AGENTRY_DSN should be defined inside the running app. " +
        "GIT_SHA should be the actual current git SHA (in CI: $(git rev-parse HEAD); on Vercel: VERCEL_GIT_COMMIT_SHA).",
    },
  ];
}

function errorCaptureSteps(framework: Framework): InstallGuideStep[] {
  const steps: InstallGuideStep[] = [
    {
      id: "init_at_entrypoint",
      title: "Initialize agentry as the FIRST thing the app does",
      why:
        "agentry must be initialized before any code that might throw. Process-level handlers (uncaughtException, unhandledRejection) " +
        "won't capture errors that happened before init() ran.",
      action: "edit",
      file_hint:
        framework === "next"
          ? "Create or edit instrumentation.ts at the project root. Next.js calls this once before any other code."
          : framework === "express"
          ? "Top of your main server file (index.ts / server.ts / app.ts) — BEFORE app.listen() and BEFORE any route imports."
          : "Top of your main entrypoint file — first lines.",
      code:
        framework === "next"
          ? `// instrumentation.ts (Next.js calls this once on server start)
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { agentry } = await import("@agentry/node");
    agentry.init({
      dsn: process.env.AGENTRY_DSN!,
      deploySha: process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA,
      environment: process.env.NODE_ENV,
    });
    process.on("uncaughtException", (err) => agentry.capture(err, { tags: { uncaught: "true" } }));
    process.on("unhandledRejection", (err) => agentry.capture(err as Error, { tags: { unhandled: "true" } }));
  }
}`
          : `import { agentry } from "@agentry/node";

agentry.init({
  dsn: process.env.AGENTRY_DSN!,
  deploySha: process.env.GIT_SHA,
  environment: process.env.NODE_ENV,
});

process.on("uncaughtException", (err) => agentry.capture(err, { tags: { uncaught: "true" } }));
process.on("unhandledRejection", (err) => agentry.capture(err as Error, { tags: { unhandled: "true" } }));`,
      validate:
        "grep for `agentry.init(` in the entrypoint file. Process listeners should be registered immediately after init.",
    },
  ];

  if (framework === "express") {
    steps.push({
      id: "express_error_middleware",
      title: "Add agentry as Express error middleware (LAST in the middleware chain)",
      why:
        "Errors thrown inside route handlers don't trigger uncaughtException — they're caught by Express. " +
        "Without this, every route-handler error vanishes.",
      action: "edit",
      file_hint: "Same file where you call app.listen(), or wherever middleware is registered.",
      code: `import { agentry } from "@agentry/node";

// ... after all routes are registered ...

app.use((err: unknown, req: import("express").Request, res: import("express").Response, _next: import("express").NextFunction) => {
  agentry.capture(err, {
    tags: { framework: "express", method: req.method },
    extra: { url: req.url, headers: scrubHeaders(req.headers) },
  });
  res.status(500).json({ error: "internal" });
});

function scrubHeaders(h: Record<string, unknown>) {
  const { authorization, cookie, ...rest } = h as Record<string, string>;
  return rest;
}`,
      validate:
        "Throw inside a route handler in dev mode and confirm a case appears via agentry_list_cases.",
    });
  }

  if (framework === "next") {
    steps.push({
      id: "next_app_router_error_boundary",
      title: "Capture App Router errors in error.tsx and global-error.tsx",
      why:
        "Next.js App Router routes errors to nearest error.tsx. Without explicit capture there, the error never reaches agentry.",
      action: "edit",
      file_hint: "app/error.tsx and app/global-error.tsx",
      code: `"use client";
// app/error.tsx
import { useEffect } from "react";
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // Note: client-side fetch to a server route that calls agentry.capture.
    fetch("/api/agentry/capture", { method: "POST", body: JSON.stringify({ message: error.message, stack: error.stack }) });
  }, [error]);
  return (<div><h2>Something broke.</h2><button onClick={reset}>Try again</button></div>);
}`,
      validate:
        "Cause a render error in dev mode, see error.tsx render, then check agentry_list_cases.",
    });
  }

  return steps;
}

function analyticsSteps(framework: Framework): InstallGuideStep[] {
  return [
    {
      id: "track_signup_completed",
      title: "Track signup_completed at the moment a user finishes signing up",
      why:
        "Without a 'signup_completed' event, no funnel can tell you anything about the top of the funnel.",
      action: "edit",
      file_hint:
        framework === "next"
          ? "The server action / API route that finalizes a new user (NOT the client form submission)."
          : "The handler that responds to the signup POST after the user is persisted.",
      code: `import { agentry } from "@agentry/node";

// after the user row is committed:
await agentry.track("signup_completed", {
  distinctId: newUser.id,
  properties: {
    method: "github",          // or "email" / "google" / etc
    plan: "free",
    referrer: req.headers["referer"] ?? null,
  },
});`,
      validate: "Sign up a new test user. The event should appear in PostHog within ~10 seconds.",
    },
    {
      id: "track_key_actions",
      title: "Track 2-3 key product actions (the things you'd care about in a funnel)",
      why:
        "A funnel needs at least 3 events to be useful: entry (signup), key_action, conversion. " +
        "Without these, the agent has nothing to investigate.",
      action: "edit",
      file_hint:
        "The handlers that complete the meaningful actions in your product. " +
        "Examples: 'project_created', 'video_generated', 'paid_upgrade', 'first_export'.",
      code: `// Examples:
await agentry.track("video_generated", { distinctId: user.id, properties: { duration_s: 12, voice: "claude" } });
await agentry.track("checkout_completed", { distinctId: user.id, properties: { amount_cents: 1900, currency: "usd" } });`,
      validate:
        "Trigger each action once with a real user. All three events should appear in PostHog. The agent will use these to build funnels.",
    },
  ];
}

function deploySteps(framework: Framework): InstallGuideStep[] {
  return [
    {
      id: "fire_deploy_event_from_ci",
      title: "Fire a deploy event from CI on every successful production deploy",
      why:
        "Without deploy events, the agent has no way to attribute a regression to a deploy. " +
        "The single highest-value signal for root-cause analysis.",
      action: "edit",
      file_hint:
        framework === "next"
          ? ".github/workflows/*.yml or your Vercel deploy hook. Run AFTER the deploy succeeds, not before."
          : ".github/workflows/*.yml or your CI's deploy step.",
      code: `# In a GitHub Actions workflow:
- name: Notify agentry of deploy
  if: success() && github.ref == 'refs/heads/main'
  run: |
    curl -fsSL -X POST "https://your-agentry-host/v1/deploys/$AGENTRY_PROJECT_ID/" \\
      -H "Authorization: Bearer $AGENTRY_DSN" \\
      -H "content-type: application/json" \\
      -d '{
        "sha": "'"\${{ github.sha }}"'",
        "branch": "'"\${{ github.ref_name }}"'",
        "environment": "production",
        "message": "'"\${{ github.event.head_commit.message }}"'",
        "url": "'"\${{ github.event.head_commit.url }}"'",
        "actor": "'"\${{ github.actor }}"'"
      }'
  env:
    AGENTRY_DSN: \${{ secrets.AGENTRY_DSN }}
    AGENTRY_PROJECT_ID: \${{ secrets.AGENTRY_PROJECT_ID }}`,
      validate:
        "Trigger a deploy. Within 30s, GET /v1/projects/:project_id/deploys should list it. " +
        "Future cases will surface this deploy in their `recent_deploys` field.",
    },
  ];
}

function verifySteps(): InstallGuideStep[] {
  return [
    {
      id: "verify_install",
      title: "Run agentry_verify_install to confirm every signal type is reaching agentry",
      why:
        "An install that ingests nothing is invisible. Verification is the only way to know it actually works.",
      action: "verify",
      validate:
        "agentry_verify_install must report ✅ for errors, analytics, and deploys. " +
        "If any signal is ❌, the corresponding step above is wrong — re-read its `validate` field and fix.",
    },
  ];
}

export function buildInstallGuide(framework: Framework, signalTypes: string[]): InstallGuide {
  const wantedSet = new Set(signalTypes.length ? signalTypes : ["errors", "analytics", "deploys"]);
  const steps: InstallGuideStep[] = [...commonSteps()];

  if (wantedSet.has("errors")) steps.push(...errorCaptureSteps(framework));
  if (wantedSet.has("analytics")) steps.push(...analyticsSteps(framework));
  if (wantedSet.has("deploys")) steps.push(...deploySteps(framework));

  steps.push(...verifySteps());

  return {
    framework,
    signal_types: [...wantedSet],
    steps,
    pitfalls: COMMON_PITFALLS,
    signal_health_principles: SIGNAL_HEALTH_PRINCIPLES,
    next_action:
      "Read each step in order. For 'edit' steps, find the file matching `file_hint` and apply `code`. " +
      "For 'run' steps, execute `command`. After all steps, call agentry_verify_install — that's the only proof the install works.",
  };
}

export function detectFramework(s: string | undefined | null): Framework {
  const v = (s ?? "").toLowerCase().trim();
  if (v === "next" || v === "nextjs" || v === "next.js") return "next";
  if (v === "express") return "express";
  return "node";
}
