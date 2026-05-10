// Hand-written install guide content. Returned by GET /v1/install/guide?framework=…
// The guide is meant to be consumed by the user's Claude Code session, which
// reads it, plans which steps apply to the user's codebase, executes them,
// then calls agentry_verify_install at the end.

export type Framework =
  | "node"
  | "next"
  | "express"
  | "browser"
  | "react"
  | "next-client";

export const SERVER_FRAMEWORKS: Framework[] = ["node", "next", "express"];
export const CLIENT_FRAMEWORKS: Framework[] = ["browser", "react", "next-client"];

export function isClientFramework(f: Framework): boolean {
  return CLIENT_FRAMEWORKS.includes(f);
}

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

function commonSteps(framework: Framework): InstallGuideStep[] {
  const isClient = isClientFramework(framework);
  return [
    {
      id: "install_sdk",
      title: isClient
        ? "Install the @agentry/browser SDK"
        : "Install the @agentry/node SDK",
      why: "Required for any error, analytics, or deploy capture.",
      action: "run",
      command: isClient ? "npm install @agentry/browser" : "npm install @agentry/node",
      validate: isClient
        ? "package.json should list @agentry/browser as a dependency."
        : "package.json should list @agentry/node as a dependency.",
    },
    {
      id: "set_env_vars",
      title: isClient
        ? "Expose AGENTRY_DSN to the client bundle (build-time injection)"
        : "Set AGENTRY_DSN and GIT_SHA in the runtime environment",
      why: isClient
        ? "DSN authenticates the SDK to agentry. It must be injected at build time " +
          "(e.g. NEXT_PUBLIC_AGENTRY_DSN, import.meta.env.VITE_AGENTRY_DSN, REACT_APP_AGENTRY_DSN). " +
          "Yes the DSN appears in the bundle — that's intentional. It only grants ingest, never reads."
        : "DSN authenticates the SDK to agentry. GIT_SHA links each event to the deploy that emitted it.",
      action: "manual",
      file_hint: isClient
        ? "Vercel env / Vite .env / Webpack DefinePlugin / Next.js env settings — " +
          "use the framework's standard PUBLIC_ prefix for client-exposed vars."
        : "Set in .env / Vercel env / Railway env / docker-compose / wherever your app reads env from at runtime.",
      validate: isClient
        ? "After build, grep your client bundle for the DSN — it should be present (it's a public token, not a secret)."
        : "process.env.AGENTRY_DSN should be defined inside the running app. " +
          "GIT_SHA should be the actual current git SHA (in CI: $(git rev-parse HEAD); on Vercel: VERCEL_GIT_COMMIT_SHA).",
    },
  ];
}

function clientErrorCaptureSteps(framework: Framework): InstallGuideStep[] {
  const initSnippet =
    framework === "react"
      ? `// src/agentry.ts (or wherever your app boots)
import { agentry } from "@agentry/browser";

agentry.init({
  dsn: import.meta.env.VITE_AGENTRY_DSN ?? process.env.REACT_APP_AGENTRY_DSN!,
  environment: import.meta.env.MODE ?? "production",
  // autoCaptureGlobalErrors defaults to true — listens to window 'error' and 'unhandledrejection'.
});

// Then import this file once at the top of src/main.tsx (or src/index.tsx).`
      : framework === "next-client"
      ? `// app/agentry.client.ts
"use client";
import { agentry } from "@agentry/browser";

if (typeof window !== "undefined") {
  agentry.init({
    dsn: process.env.NEXT_PUBLIC_AGENTRY_DSN!,
    environment: process.env.NODE_ENV,
  });
}

// In app/layout.tsx, add: import "./agentry.client";`
      : `// near the top of your client entrypoint
import { agentry } from "@agentry/browser";

agentry.init({
  dsn: window.AGENTRY_DSN ?? process.env.AGENTRY_DSN!,
  environment: process.env.NODE_ENV,
});`;

  const steps: InstallGuideStep[] = [
    {
      id: "init_at_entrypoint",
      title: "Initialize agentry as the FIRST thing the client bundle runs",
      why:
        "agentry must be initialized before any code that might throw, including framework boot. " +
        "Once init() is called, window 'error' and 'unhandledrejection' listeners attach automatically " +
        "(autoCaptureGlobalErrors defaults to true).",
      action: "edit",
      file_hint:
        framework === "react"
          ? "Create src/agentry.ts and import it FIRST from src/main.tsx (before app render)."
          : framework === "next-client"
          ? "Create app/agentry.client.ts as a `'use client'` module and import it from app/layout.tsx (server component is fine — Next will hoist the import)."
          : "Top of your client entrypoint, BEFORE the rest of your app boots.",
      code: initSnippet,
      validate: "grep for `agentry.init(` in the client entrypoint. Must run before any other component code.",
    },
  ];

  if (framework === "react" || framework === "next-client") {
    steps.push({
      id: "react_error_boundary",
      title: "Capture React render errors via an ErrorBoundary",
      why:
        "window 'error' doesn't catch errors thrown during React render — only ErrorBoundary does. " +
        "Without this, every render-time bug vanishes from agentry.",
      action: "edit",
      file_hint:
        framework === "react"
          ? "Create src/components/AgentryErrorBoundary.tsx and wrap your <App /> with it."
          : "app/error.tsx and app/global-error.tsx (Next App Router). Both are auto-wired by Next.",
      code:
        framework === "react"
          ? `"use client";
import { Component, type ReactNode } from "react";
import { agentry } from "@agentry/browser";

export class AgentryErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: { componentStack?: string }) {
    agentry.capture(error, {
      tags: { source: "react_error_boundary" },
      extra: { componentStack: info.componentStack },
    });
  }
  render() {
    if (this.state.error) return <h2>Something broke. The team's been notified.</h2>;
    return this.props.children;
  }
}

// Use in src/main.tsx:
// <AgentryErrorBoundary><App /></AgentryErrorBoundary>`
          : `"use client";
// app/error.tsx
import { useEffect } from "react";
import { agentry } from "@agentry/browser";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    agentry.capture(error, { tags: { source: "next_error_boundary" } });
  }, [error]);
  return (<div><h2>Something broke.</h2><button onClick={reset}>Try again</button></div>);
}

// Same shape for app/global-error.tsx — that one wraps the whole tree.`,
      validate: "Throw inside a component render in dev. Boundary should render and a case appear in agentry_list_cases.",
    });
  }

  return steps;
}

function clientAnalyticsSteps(framework: Framework): InstallGuideStep[] {
  return [
    {
      id: "track_page_view",
      title: "Track page_view on every route change",
      why:
        "Funnels start with traffic. Without page_view events, retention curves and funnel widths are guesses.",
      action: "edit",
      file_hint:
        framework === "react"
          ? "Listen on react-router or wouter route changes (or just call agentry.track on initial load if SPA)."
          : framework === "next-client"
          ? "app/agentry-router-tracker.tsx — a 'use client' component using usePathname() + useEffect to fire on path change."
          : "On every route change in your client router. For static sites, fire once per page load.",
      code:
        framework === "next-client"
          ? `"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { agentry } from "@agentry/browser";

export function AgentryRouterTracker() {
  const pathname = usePathname();
  useEffect(() => {
    agentry.track("page_view", { properties: { path: pathname } });
  }, [pathname]);
  return null;
}

// Mount once in app/layout.tsx alongside agentry.client import.`
          : `import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { agentry } from "@agentry/browser";

export function PageViewTracker() {
  const loc = useLocation();
  useEffect(() => { agentry.track("page_view", { properties: { path: loc.pathname } }); }, [loc.pathname]);
  return null;
}`,
      validate: "Navigate between two routes. Two page_view events should appear in PostHog within ~10 seconds.",
    },
    {
      id: "track_key_actions_client",
      title: "Track 2-3 key product actions from the client (the funnel signals)",
      why:
        "Server-side analytics misses ~30% of events to ad-blockers and pre-submission flows. Track the user-action events from the browser at the actual moment of the action. " +
        "Track the SERVER side too for the same actions (double-fire) when the action persists data — server is authoritative, client gives you the funnel.",
      action: "edit",
      file_hint:
        "onClick / onSubmit handlers for the meaningful user actions: 'cta_clicked', 'signup_form_submitted', 'video_played', 'paywall_viewed'.",
      code: `import { agentry } from "@agentry/browser";

// In a button onClick:
<button onClick={() => {
  agentry.track("cta_clicked", { properties: { cta_id: "hero_signup", page: window.location.pathname } });
  // ... the actual navigation
}}>Sign up</button>

// Form submission:
async function handleSubmit(form: FormData) {
  agentry.track("signup_form_submitted", { properties: { form_variant: "v2" } });
  // ... call your server action
}`,
      validate: "Click each tracked control once. Events should appear in PostHog (cross-check with agentry_analytics_query).",
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
  const steps: InstallGuideStep[] = [...commonSteps(framework)];
  const isClient = isClientFramework(framework);

  if (wantedSet.has("errors")) {
    steps.push(...(isClient ? clientErrorCaptureSteps(framework) : errorCaptureSteps(framework)));
  }
  if (wantedSet.has("analytics")) {
    steps.push(...(isClient ? clientAnalyticsSteps(framework) : analyticsSteps(framework)));
  }
  // Deploy events are CI-side, never client-side.
  if (wantedSet.has("deploys") && !isClient) steps.push(...deploySteps(framework));

  steps.push(...verifySteps());

  const pitfalls = isClient
    ? [
        "DSNs in client bundles are public tokens, not secrets — they only grant ingest. Don't be alarmed when you see yours in DevTools.",
        "Don't init agentry in server-only files of a Next.js app — use the @agentry/node SDK there. The browser SDK has no Node primitives.",
        "Source maps: in production builds, stack traces will reference minified filenames. Source-map upload is a v0.x feature; for now, agents can still match by error message + URL.",
        "Don't track sensitive form values in event properties. Track that the action happened, not what was entered.",
        "On mobile Safari, fetch may fail silently during page transitions. The SDK falls back to navigator.sendBeacon on visibilitychange='hidden'.",
      ]
    : COMMON_PITFALLS;

  return {
    framework,
    signal_types: [...wantedSet],
    steps,
    pitfalls,
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
  if (v === "browser" || v === "vanilla") return "browser";
  if (v === "react" || v === "vite" || v === "cra") return "react";
  if (v === "next-client" || v === "next-app-router-client") return "next-client";
  return "node";
}
