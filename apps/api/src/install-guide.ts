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
  | "next-client"
  // Direct-HTTP languages — agentry is just three POST endpoints, any HTTP client works.
  | "python"
  | "ruby"
  | "go"
  | "php"
  | "java"
  | "dotnet"
  | "rust"
  | "elixir"
  | "curl";

export const SERVER_FRAMEWORKS: Framework[] = ["node", "next", "express"];
export const CLIENT_FRAMEWORKS: Framework[] = ["browser", "react", "next-client"];
export const HTTP_FRAMEWORKS: Framework[] = [
  "python", "ruby", "go", "php", "java", "dotnet", "rust", "elixir", "curl",
];

export function isClientFramework(f: Framework): boolean {
  return CLIENT_FRAMEWORKS.includes(f);
}
export function isHttpFramework(f: Framework): boolean {
  return HTTP_FRAMEWORKS.includes(f);
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

// Privacy policy step. Two reasons to ship this:
//   1. It's the right thing to do — customers SHOULD disclose what they track
//      once they've wired up monitoring.
//   2. Operational realism — every customer's published privacy policy linking
//      back to agentry.sh is honest backlink-building. The link is genuinely
//      useful (points at our public retention/data-handling docs) so neither
//      party has to feel weird about it.
//
// We tell the agent to UPDATE an existing privacy policy if one exists, and
// to flag it for the human (don't auto-create) if none does — privacy policy
// authoring is a legal decision the human owns.
function privacyPolicyStep(framework: Framework, signalTypes: Set<string>): InstallGuideStep {
  const isClient = isClientFramework(framework);
  const wantsErrors = signalTypes.has("errors");
  const wantsAnalytics = signalTypes.has("analytics");

  const sections: string[] = [];

  if (wantsErrors) {
    sections.push(
      isClient
        ? `### Error monitoring

We use [agentry](https://agentry.sh) to monitor application errors. When an error \
occurs in your browser, agentry receives the error type, message, and stack trace; \
the page URL where it occurred; your browser's user-agent string; and the deploy \
version that emitted it. We do not intentionally collect personal data through \
error monitoring. See [agentry's data handling](https://agentry.sh/privacy) for \
how this data is stored and retained.`
        : `### Error monitoring

We use [agentry](https://agentry.sh) to monitor application errors. When an error \
occurs, agentry receives the error type, message, and stack trace; the URL, \
environment, and deploy version that emitted it; and any contextual metadata our \
code attaches. We do not intentionally collect personal data through error \
monitoring; see [agentry's data handling](https://agentry.sh/privacy) for storage \
and retention details.`,
    );
  }

  if (wantsAnalytics) {
    sections.push(
      isClient
        ? `### Product analytics

We track aggregate product usage to improve the experience. Tracked events include \
page views, key product actions (e.g. signup, checkout), and contextual properties \
such as the page URL, referrer, browser language, and user-agent. We assign a \
randomly-generated identifier stored in your browser's \`localStorage\` to keep \
your interactions consistent across visits; this identifier is not linked to your \
name or email unless you explicitly identify yourself. Analytics is processed via \
[agentry](https://agentry.sh) and PostHog. You can opt out by clearing your browser \
storage for this site.`
        : `### Product analytics

We track aggregate product usage server-side to improve the experience. Tracked \
events include the action name (e.g. \`signup_completed\`, \`checkout_completed\`) \
and contextual properties our code attaches at the moment of the action. We may \
associate events with your authenticated user id; this is used only for funnel and \
retention analysis. Analytics is processed via [agentry](https://agentry.sh) and \
PostHog.`,
    );
  }

  const fullClause =
    `## Monitoring & analytics\n\n` +
    sections.join("\n\n") +
    `\n\n*This monitoring is provided by [agentry](https://agentry.sh), an agent-first ` +
    `observability platform. Questions about how your data is handled? Contact us, or ` +
    `see [agentry's documentation](https://agentry.sh).*\n`;

  const fileHints = isClient
    ? "Look for the existing privacy policy. Common locations: " +
      "`app/privacy/page.tsx`, `app/legal/privacy/page.tsx`, `pages/privacy.tsx`, " +
      "`pages/privacy.mdx`, `src/routes/privacy.tsx`, `public/privacy.html`, " +
      "`PRIVACY.md`, `docs/privacy.md`, `legal/privacy.md`."
    : "Look for the existing privacy policy. Common locations: `PRIVACY.md`, " +
      "`docs/privacy.md`, `legal/privacy.md`, `views/privacy.ejs`, `public/privacy.html`, " +
      "or any route that renders /privacy. If your app has a server-rendered privacy " +
      "page (Rails view, Django template, Phoenix template), edit it there.";

  return {
    id: "update_privacy_policy",
    title: "Update the privacy policy with what's now being tracked",
    why:
      "Once monitoring is live, your privacy policy is no longer accurate. Many " +
      "jurisdictions (GDPR, CCPA, etc.) require disclosure of automated processing — " +
      "this section keeps you compliant and your users informed. The clause below is " +
      "drafted to be accurate to what agentry actually captures (and only what it " +
      "captures); paste it as a new section, or merge it into your existing 'Tracking' / " +
      "'Cookies' / 'Third parties' section. " +
      "If no privacy policy file exists, FLAG IT FOR THE HUMAN — agentry won't auto-create one.",
    action: "edit",
    file_hint: fileHints,
    code: fullClause,
    validate:
      "After editing, the privacy policy should mention: agentry, the linked agentry.sh URL, " +
      (wantsErrors ? "what error data is captured (stack, URL, deploy version), " : "") +
      (wantsAnalytics ? "what analytics events are captured (page views, key actions, identifier), " : "") +
      "and the agentry.sh link should resolve.",
  };
}

export function buildInstallGuide(framework: Framework, signalTypes: string[]): InstallGuide {
  const wantedSet = new Set(signalTypes.length ? signalTypes : ["errors", "analytics", "deploys"]);

  // Direct-HTTP languages get a separate, simpler builder.
  if (isHttpFramework(framework)) {
    return buildHttpGuide(framework, wantedSet);
  }

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

  // Privacy policy update — only when we're capturing user-affecting data.
  if (wantedSet.has("errors") || wantedSet.has("analytics")) {
    steps.push(privacyPolicyStep(framework, wantedSet));
  }

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
  if (["python", "django", "flask", "fastapi"].includes(v)) return "python";
  if (["ruby", "rails", "sinatra"].includes(v)) return "ruby";
  if (["go", "golang", "gin", "echo"].includes(v)) return "go";
  if (["php", "laravel", "symfony"].includes(v)) return "php";
  if (["java", "kotlin", "spring", "spring-boot"].includes(v)) return "java";
  if (["dotnet", "csharp", "c#", "aspnetcore", "aspnet"].includes(v)) return "dotnet";
  if (["rust", "actix", "axum", "rocket"].includes(v)) return "rust";
  if (["elixir", "phoenix"].includes(v)) return "elixir";
  if (["curl", "http", "shell", "bash"].includes(v)) return "curl";
  return "node";
}

// ---------------------------------------------------------------------------
// Direct-HTTP language guides
// ---------------------------------------------------------------------------
//
// Premise: agentry is just HTTP. Three POST endpoints accept JSON. So the
// "install" for any language is "set the DSN, write a 5-line helper, call it."
// No SDK install. No import of agentry. The helper is a copy-paste artifact.
// ---------------------------------------------------------------------------

interface LangRecipe {
  language_human: string;
  install_lib?: { command: string; reason: string }; // optional — most stdlibs are enough
  helper_code: string;
  helper_file_hint: string;
  error_handler: { code: string; file_hint: string };
}

const LANG_RECIPES: Record<Exclude<Framework, "node" | "next" | "express" | "browser" | "react" | "next-client">, LangRecipe> = {
  python: {
    language_human: "Python",
    install_lib: { command: "pip install requests", reason: "Stdlib urllib works too; requests is just easier." },
    helper_file_hint: "Create a thin agentry.py module wherever your project keeps shared utilities.",
    helper_code: `# agentry.py
import os, json, traceback, requests

AGENTRY_URL = os.environ["AGENTRY_URL"]      # e.g. https://api.agentry.sh
AGENTRY_DSN = os.environ["AGENTRY_DSN"]      # agnt_<projectId>.<token>
PROJECT_ID = AGENTRY_DSN.split("_", 1)[1].split(".", 1)[0]

def log(payload):
    """Just like print() — agentry routes whatever you send to the right place."""
    try:
        if isinstance(payload, BaseException):
            payload = {
                "kind": "error",
                "name": type(payload).__name__,
                "message": str(payload),
                "stack": "".join(traceback.format_exception(type(payload), payload, payload.__traceback__)),
            }
        requests.post(
            f"{AGENTRY_URL}/v1/log/{PROJECT_ID}/",
            headers={"authorization": f"Bearer {AGENTRY_DSN}", "content-type": "application/json"},
            data=json.dumps(payload),
            timeout=5,
        )
    except Exception:
        pass  # never let monitoring crash the app
`,
    error_handler: {
      file_hint:
        "Wherever your framework registers global error handlers — Django: settings.py + middleware; " +
        "Flask: @app.errorhandler(Exception); FastAPI: @app.exception_handler(Exception). " +
        "Just call agentry.log(exc). Set AGENTRY_DSN and AGENTRY_URL env vars.",
      code: `# Flask example
from flask import Flask
import agentry

app = Flask(__name__)

@app.errorhandler(Exception)
def handle_all(exc):
    agentry.log(exc)
    raise exc

# Track an analytics event:
agentry.log({"event": "signup_completed", "distinct_id": user_id, "properties": {"plan": "free"}})

# Record a deploy from CI / startup:
agentry.log({"sha": os.environ["GIT_SHA"], "environment": "production"})`,
    },
  },
  ruby: {
    language_human: "Ruby",
    helper_file_hint: "Create app/lib/agentry.rb (Rails) or lib/agentry.rb (Sinatra/plain).",
    helper_code: `# lib/agentry.rb
require "net/http"
require "json"
require "uri"

module Agentry
  URL = ENV.fetch("AGENTRY_URL")
  DSN = ENV.fetch("AGENTRY_DSN")
  PROJECT_ID = DSN.split("_", 2)[1].split(".", 2)[0]

  def self.log(payload)
    if payload.is_a?(Exception)
      payload = {
        kind: "error",
        name: payload.class.name,
        message: payload.message,
        stack: payload.backtrace&.join("\\n"),
      }
    end
    uri = URI("#{URL}/v1/log/#{PROJECT_ID}/")
    req = Net::HTTP::Post.new(uri, "authorization" => "Bearer #{DSN}", "content-type" => "application/json")
    req.body = payload.to_json
    Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https") { |h| h.request(req) }
  rescue => _
    nil  # never let monitoring crash the app
  end
end`,
    error_handler: {
      file_hint:
        "Rails: config/application.rb (use Rails.application.config.exceptions_app or rescue_from in ApplicationController). " +
        "Sinatra: error do block.",
      code: `# Rails: app/controllers/application_controller.rb
class ApplicationController < ActionController::Base
  rescue_from StandardError do |e|
    Agentry.log(e)
    raise e
  end
end

# Track an event:
Agentry.log(event: "signup_completed", distinct_id: current_user.id, properties: { plan: "free" })

# Record a deploy:
Agentry.log(sha: ENV["GIT_SHA"], environment: "production")`,
    },
  },
  go: {
    language_human: "Go",
    helper_file_hint: "Create internal/agentry/agentry.go (or wherever your project keeps shared packages).",
    helper_code: `// internal/agentry/agentry.go
package agentry

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
    "os"
    "runtime/debug"
    "strings"
    "time"
)

var (
    url       = os.Getenv("AGENTRY_URL")
    dsn       = os.Getenv("AGENTRY_DSN")
    projectID = strings.SplitN(strings.SplitN(dsn, "_", 2)[1], ".", 2)[0]
    client    = &http.Client{Timeout: 5 * time.Second}
)

// Log accepts any value. errors get serialized with stack; everything else is sent verbatim.
func Log(payload any) {
    if err, ok := payload.(error); ok {
        payload = map[string]any{
            "kind":    "error",
            "name":    fmt.Sprintf("%T", err),
            "message": err.Error(),
            "stack":   string(debug.Stack()),
        }
    }
    body, _ := json.Marshal(payload)
    req, _ := http.NewRequest("POST", url+"/v1/log/"+projectID+"/", bytes.NewReader(body))
    req.Header.Set("authorization", "Bearer "+dsn)
    req.Header.Set("content-type", "application/json")
    res, err := client.Do(req)
    if err != nil { return } // never crash the app
    res.Body.Close()
}`,
    error_handler: {
      file_hint:
        "Wrap your http.Handler with a recovery middleware. Gin: gin.Recovery() + custom middleware. " +
        "Echo: middleware.RecoverWithConfig.",
      code: `// Generic net/http recovery middleware
func AgentryRecovery(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if rec := recover(); rec != nil {
                if err, ok := rec.(error); ok {
                    agentry.Log(err)
                } else {
                    agentry.Log(map[string]any{"kind": "error", "message": fmt.Sprint(rec)})
                }
                http.Error(w, "internal", 500)
            }
        }()
        next.ServeHTTP(w, r)
    })
}

// Track:
agentry.Log(map[string]any{"event": "signup_completed", "distinct_id": userID})

// Deploy:
agentry.Log(map[string]any{"sha": os.Getenv("GIT_SHA"), "environment": "production"})`,
    },
  },
  php: {
    language_human: "PHP",
    helper_file_hint: "src/Agentry.php (PSR-4 compatible).",
    helper_code: `<?php
// src/Agentry.php
class Agentry {
    public static function log(mixed $payload): void {
        $url = getenv("AGENTRY_URL");
        $dsn = getenv("AGENTRY_DSN");
        $projectId = explode(".", explode("_", $dsn, 2)[1], 2)[0];

        if ($payload instanceof \\Throwable) {
            $payload = [
                "kind" => "error",
                "name" => get_class($payload),
                "message" => $payload->getMessage(),
                "stack" => $payload->getTraceAsString(),
            ];
        }
        $ch = curl_init("$url/v1/log/$projectId/");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_HTTPHEADER => ["authorization: Bearer $dsn", "content-type: application/json"],
            CURLOPT_TIMEOUT => 5,
            CURLOPT_RETURNTRANSFER => true,
        ]);
        try { curl_exec($ch); } catch (\\Throwable $_) {}  // never crash the app
        curl_close($ch);
    }
}`,
    error_handler: {
      file_hint:
        "Laravel: app/Exceptions/Handler.php, override report(). " +
        "Symfony: a Kernel exception event listener. Vanilla: set_exception_handler().",
      code: `// Laravel app/Exceptions/Handler.php
public function report(Throwable $e) {
    Agentry::log($e);
    parent::report($e);
}

// Track:
Agentry::log(["event" => "signup_completed", "distinct_id" => $userId]);

// Deploy:
Agentry::log(["sha" => getenv("GIT_SHA"), "environment" => "production"]);`,
    },
  },
  java: {
    language_human: "Java / Kotlin",
    helper_file_hint:
      "Create src/main/java/com/yourapp/Agentry.java (Spring/plain Java) or " +
      "src/main/kotlin/.../Agentry.kt (Kotlin).",
    helper_code: `// Java — uses java.net.http (JDK 11+)
package com.yourapp;

import java.net.URI;
import java.net.http.*;
import java.net.http.HttpRequest.BodyPublishers;
import java.io.PrintWriter;
import java.io.StringWriter;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;

public class Agentry {
    private static final String URL = System.getenv("AGENTRY_URL");
    private static final String DSN = System.getenv("AGENTRY_DSN");
    private static final String PROJECT_ID = DSN.split("_", 2)[1].split("\\\\.", 2)[0];
    private static final HttpClient CLIENT = HttpClient.newHttpClient();
    private static final ObjectMapper MAPPER = new ObjectMapper();

    public static void log(Object payload) {
        try {
            if (payload instanceof Throwable t) {
                StringWriter sw = new StringWriter();
                t.printStackTrace(new PrintWriter(sw));
                payload = Map.of("kind", "error", "name", t.getClass().getName(),
                    "message", String.valueOf(t.getMessage()), "stack", sw.toString());
            }
            HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(URL + "/v1/log/" + PROJECT_ID + "/"))
                .header("authorization", "Bearer " + DSN)
                .header("content-type", "application/json")
                .POST(BodyPublishers.ofString(MAPPER.writeValueAsString(payload)))
                .build();
            CLIENT.sendAsync(req, HttpResponse.BodyHandlers.discarding());
        } catch (Exception ignored) {}
    }
}`,
    error_handler: {
      file_hint:
        "Spring Boot: @ControllerAdvice with @ExceptionHandler(Exception.class). " +
        "Plain: Thread.setDefaultUncaughtExceptionHandler.",
      code: `// Spring Boot
@ControllerAdvice
public class AgentryAdvice {
    @ExceptionHandler(Exception.class)
    public ResponseEntity<String> handle(Exception e) {
        Agentry.log(e);
        return ResponseEntity.status(500).body("internal");
    }
}

// Plain Java startup:
Thread.setDefaultUncaughtExceptionHandler((thread, ex) -> Agentry.log(ex));

// Track / Deploy: Agentry.log(Map.of("event", "signup_completed", "distinct_id", userId));`,
    },
  },
  dotnet: {
    language_human: ".NET (C#)",
    helper_file_hint: "Add Agentry.cs to your shared library or main project.",
    helper_code: `// Agentry.cs — .NET 8+ uses System.Net.Http + System.Text.Json
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;

public static class Agentry {
    private static readonly string Url = Environment.GetEnvironmentVariable("AGENTRY_URL")!;
    private static readonly string Dsn = Environment.GetEnvironmentVariable("AGENTRY_DSN")!;
    private static readonly string ProjectId = Dsn.Split('_', 2)[1].Split('.', 2)[0];
    private static readonly HttpClient Client = new() { Timeout = TimeSpan.FromSeconds(5) };

    public static async Task Log(object payload) {
        try {
            if (payload is Exception ex) {
                payload = new Dictionary<string, object?> {
                    ["kind"] = "error",
                    ["name"] = ex.GetType().FullName,
                    ["message"] = ex.Message,
                    ["stack"] = ex.ToString(),
                };
            }
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{Url}/v1/log/{ProjectId}/") {
                Content = JsonContent.Create(payload),
            };
            req.Headers.TryAddWithoutValidation("authorization", $"Bearer {Dsn}");
            await Client.SendAsync(req);
        } catch { /* never crash the app */ }
    }
}`,
    error_handler: {
      file_hint:
        "ASP.NET Core: app.UseExceptionHandler with custom middleware in Program.cs.",
      code: `// Program.cs
app.UseExceptionHandler(b => b.Run(async ctx => {
    var ex = ctx.Features.Get<IExceptionHandlerFeature>()?.Error;
    if (ex != null) await Agentry.Log(ex);
    ctx.Response.StatusCode = 500;
    await ctx.Response.WriteAsync("internal");
}));

// Track:
await Agentry.Log(new { @event = "signup_completed", distinct_id = userId });

// Deploy:
await Agentry.Log(new { sha = Environment.GetEnvironmentVariable("GIT_SHA"), environment = "production" });`,
    },
  },
  rust: {
    language_human: "Rust",
    install_lib: { command: "cargo add reqwest serde_json --features reqwest/json", reason: "Reqwest is the standard HTTP client; serde_json for serialization." },
    helper_file_hint: "Add src/agentry.rs as a module on your library/binary crate.",
    helper_code: `// src/agentry.rs
use serde_json::{json, Value};
use std::env;

fn project_id() -> String {
    let dsn = env::var("AGENTRY_DSN").unwrap_or_default();
    dsn.splitn(2, '_').nth(1).and_then(|s| s.splitn(2, '.').next()).unwrap_or("").into()
}

pub async fn log(payload: Value) {
    let url = env::var("AGENTRY_URL").unwrap_or_default();
    let dsn = env::var("AGENTRY_DSN").unwrap_or_default();
    let pid = project_id();
    let _ = reqwest::Client::new()
        .post(format!("{url}/v1/log/{pid}/"))
        .bearer_auth(&dsn)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;  // never crash the app
}

pub async fn log_error(err: &dyn std::error::Error) {
    log(json!({
        "kind": "error",
        "name": format!("{:?}", err),
        "message": err.to_string(),
        "stack": format!("{:?}", err),  // backtrace via std::backtrace::Backtrace if available
    })).await;
}`,
    error_handler: {
      file_hint:
        "Wrap your axum/actix routes with a panic-catching layer that calls agentry::log_error. " +
        "Or use std::panic::set_hook in main().",
      code: `// In main(), set a panic hook so unrecovered panics get reported:
std::panic::set_hook(Box::new(|info| {
    let msg = info.to_string();
    let _ = tokio::runtime::Handle::try_current().map(|h| {
        h.spawn(crate::agentry::log(serde_json::json!({
            "kind": "error", "name": "panic", "message": msg
        })));
    });
}));

// Track / Deploy: agentry::log(json!({"event": "signup_completed", "distinct_id": user_id})).await;`,
    },
  },
  elixir: {
    language_human: "Elixir / Phoenix",
    helper_file_hint: "lib/agentry.ex on a Phoenix or plain Elixir project.",
    helper_code: `# lib/agentry.ex
defmodule Agentry do
  @url System.get_env("AGENTRY_URL")
  @dsn System.get_env("AGENTRY_DSN")

  def project_id, do: @dsn |> String.split("_", parts: 2) |> Enum.at(1) |> String.split(".", parts: 2) |> Enum.at(0)

  def log(payload) do
    payload = normalize(payload)
    url = "#{@url}/v1/log/#{project_id()}/"
    headers = [{"authorization", "Bearer #{@dsn}"}, {"content-type", "application/json"}]
    body = Jason.encode!(payload)
    Task.start(fn -> :hackney.request(:post, url, headers, body, [recv_timeout: 5_000]) end)
    :ok
  end

  defp normalize(%{__exception__: true} = ex) do
    %{kind: "error", name: ex.__struct__ |> Atom.to_string(), message: Exception.message(ex),
      stack: Exception.format(:error, ex, __STACKTRACE__)}
  end
  defp normalize(other), do: other
end`,
    error_handler: {
      file_hint:
        "Phoenix: a custom Plug.ErrorHandler. Plain: rescue blocks at top-level Task supervisors.",
      code: `# Phoenix endpoint.ex
plug Plug.ErrorHandler

defp handle_errors(_conn, %{kind: _kind, reason: reason, stack: _stack}) do
  Agentry.log(reason)
end

# Track:
Agentry.log(%{event: "signup_completed", distinct_id: user.id, properties: %{plan: "free"}})

# Deploy:
Agentry.log(%{sha: System.get_env("GIT_SHA"), environment: "production"})`,
    },
  },
  curl: {
    language_human: "curl / shell / any HTTP client",
    helper_file_hint: "No helper needed — agentry is just one POST.",
    helper_code: `# Set your env vars first:
export AGENTRY_URL="https://api.agentry.sh"
export AGENTRY_DSN="agnt_<projectId>.<token>"
export PROJECT_ID="\${AGENTRY_DSN#agnt_}"
export PROJECT_ID="\${PROJECT_ID%%.*}"

# Send any JSON payload — agentry figures out what kind of signal it is:
agentry_log() {
  curl -fsS -X POST "$AGENTRY_URL/v1/log/$PROJECT_ID/" \\
    -H "authorization: Bearer $AGENTRY_DSN" \\
    -H "content-type: application/json" \\
    -d "$1" >/dev/null 2>&1 || true
}`,
    error_handler: {
      file_hint:
        "Anywhere a script can throw or a process exits non-zero. Wrap with 'trap' in bash, " +
        "or call agentry_log explicitly after \`|| true\` patterns to capture failures.",
      code: `# Bash trap on error
trap 'agentry_log "{\\"kind\\":\\"error\\",\\"message\\":\\"line $LINENO failed: $BASH_COMMAND\\"}"' ERR

# Track an event:
agentry_log '{"event": "cron_completed", "distinct_id": "etl-job-1", "properties": {"rows": 42}}'

# Record a deploy from CI:
agentry_log '{"sha": "'"$GITHUB_SHA"'", "branch": "'"$GITHUB_REF_NAME"'", "environment": "production"}'`,
    },
  },
};

function buildHttpGuide(framework: Framework, signalTypes: Set<string>): InstallGuide {
  const recipe = LANG_RECIPES[framework as keyof typeof LANG_RECIPES];
  if (!recipe) {
    // Shouldn't happen — caller already gated on isHttpFramework.
    return buildInstallGuide("node", [...signalTypes]);
  }
  const steps: InstallGuideStep[] = [];

  if (recipe.install_lib) {
    steps.push({
      id: "install_http_lib",
      title: `Install an HTTP client (${recipe.language_human})`,
      why: recipe.install_lib.reason,
      action: "run",
      command: recipe.install_lib.command,
      validate: "Library should appear in your dependency manifest.",
    });
  }

  steps.push({
    id: "set_env_vars",
    title: "Set AGENTRY_DSN and AGENTRY_URL in the runtime environment",
    why:
      "DSN authenticates each event to your project; URL points at the agentry deployment. " +
      "These are read by the helper module, never hardcoded.",
    action: "manual",
    file_hint:
      "Set in .env / Heroku config / docker-compose / your platform's env settings. " +
      "AGENTRY_URL example: https://api.agentry.sh. AGENTRY_DSN format: agnt_<projectId>.<token> " +
      "(get this from `agentry_create_project`).",
    validate: "Both env vars must be readable by the running process.",
  });

  steps.push({
    id: "drop_in_helper",
    title: `Drop in the agentry helper (${recipe.language_human})`,
    why:
      "agentry's API is just three POST endpoints. The helper is a copy-paste artifact — no SDK install, " +
      "no agentry-named dependency to vet. The whole helper is ~30 lines.",
    action: "edit",
    file_hint: recipe.helper_file_hint,
    code: recipe.helper_code,
    validate:
      "Function/module is callable from your app. Calling it with a test payload should not throw.",
  });

  if (signalTypes.has("errors") || signalTypes.has("analytics") || signalTypes.has("deploys")) {
    steps.push({
      id: "wire_signal_capture",
      title: "Wire up error / analytics / deploy capture",
      why:
        "Errors get caught by your framework's error handler and forwarded. Analytics events and " +
        "deploys are explicit calls. All three go through the same `log()` helper.",
      action: "edit",
      file_hint: recipe.error_handler.file_hint,
      code: recipe.error_handler.code,
      validate:
        "Throw an unhandled exception in dev. The case should appear in agentry_list_cases. " +
        "Track an event. Verify it arrives in PostHog (agentry_analytics_query). " +
        "If a CI deploy step calls deploy variant, agentry_list_deploys should show it.",
    });
  }

  if (signalTypes.has("errors") || signalTypes.has("analytics")) {
    steps.push(privacyPolicyStep(framework, signalTypes));
  }

  steps.push(...verifySteps());

  return {
    framework,
    signal_types: [...signalTypes],
    steps,
    pitfalls: [
      "Don't fail the request if logging fails. The helper has try/catch (or equivalent) — keep it.",
      "Don't log sensitive request bodies. Strip auth tokens and PII before passing to log().",
      "AGENTRY_DSN is ingest-only; safe to deploy as a regular env var (not a high-risk secret).",
      "If your platform restricts outbound HTTP, allowlist the agentry deployment host.",
    ],
    signal_health_principles: SIGNAL_HEALTH_PRINCIPLES,
    next_action:
      "Read each step in order. After all steps land, call agentry_verify_install — that's the only proof " +
      "the install actually works. The helper is intentionally tiny so an agent can review every line.",
  };
}
