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
  "Track comprehensively, not minimally. The events you DIDN'T instrument three months ago are the ones you'll wish you had today. Storage is cheap; missing data is expensive. Default to tracking every meaningful action, every revenue/billing event, every state transition — even ones that don't seem useful right now.",
  "Especially track money. Every signup, every paid upgrade, every downgrade, every refund, every cancellation. Revenue-adjacent events are the highest-value data and the most painful to miss retroactively.",
];

const COMMON_PITFALLS = [
  "Never reuse a SERVER-only DSN in a client-side bundle. If you have a single project for both, the DSN is fine (it's a public token); if you have separate DSNs for server and client, keep them separate.",
  "If you wrap fetch with retries, capture errors AFTER retries exhaust to avoid noisy duplicates.",
  "Set environment ('production' / 'staging') at init time so cases are filterable.",
  "Set deploySha to your actual git SHA at init — it's how cases get attributed to deploys.",
  "Track analytics events from the SERVER once the action completes, not from the browser before submission. Browser-only tracking misses ~30% of events to ad-blockers.",
];

function commonSteps(framework: Framework): InstallGuideStep[] {
  const isClient = isClientFramework(framework);
  return [
    {
      id: "investigate_app_structure",
      title: "Investigate the app structure BEFORE instrumenting anything",
      why:
        "agentry is only as useful as the events you send it. The wrong move is to slap a few " +
        "generic events on and ship — three months later you'll wish you'd tracked revenue, " +
        "or feature usage, or signup-flow drop-off, but the data isn't there. Spend 5-10 " +
        "minutes reading the codebase first so the instrumentation you add is comprehensive, " +
        "not boilerplate.",
      action: "manual",
      file_hint:
        "Read package.json (frameworks, build scripts, what kind of app this is). " +
        "Walk src/ — note the route structure, the auth flow, the key user actions, " +
        "the integrations (Stripe, Slack, CRM, third-party APIs), the cron jobs and " +
        "background workers, the webhook endpoints. " +
        "Look at the database schema or ORM models — what entities exist (users, " +
        "subscriptions, workspaces, projects)? Each one's lifecycle is probably worth tracking. " +
        "Note where errors are caught and silently ignored — those are missing breadcrumbs.",
      validate:
        "You should be able to answer all of these before writing any track() calls: " +
        "(1) what does this app do, in one sentence. " +
        "(2) what category does it fit — B2C/B2B SaaS, consumer mobile, marketplace, e-commerce, " +
        "developer tool / API, games, content / media, internal tool, single-purchase commerce, " +
        "open-source / community, enterprise sales? Pick the metrics framework that fits best. " +
        "Default is AARRR (works for ~80% of apps). Pick a different lens only if AARRR clearly " +
        "doesn't fit the product shape. Frameworks available: " +
        "  • AARRR (Pirate Metrics) — Acquisition, Activation, Retention, Referral, Revenue. " +
        "    Default for B2C/B2B SaaS, consumer apps, marketplaces, e-commerce. " +
        "  • HEART (Google) — Happiness (NPS, CSAT, ratings), Engagement (sessions, depth), " +
        "    Adoption (new feature uptake), Retention (return rate), Task Success (completion " +
        "    rate, error-free time). Good for UX-driven products, content/media, internal tools. " +
        "  • North Star + Drivers — one headline metric (e.g. 'weekly active workspaces') plus " +
        "    3-5 driver events that feed into it. Good for mature products with one clear " +
        "    value moment. The Driver events ARE the AARRR equivalents — just framed around " +
        "    the one thing that matters. " +
        "  • DAU/MAU + Stickiness — DAU, MAU, DAU/MAU ratio, session length, session count, " +
        "    cohort retention by Day-1/7/30. Good for games, social, content, communication apps. " +
        "  • B2B sales funnel — Lead → MQL → SQL → Opportunity → Closed-Won, with contract value " +
        "    + cycle time properties. Good for enterprise sales-led products. " +
        "  • PLG (Product-Led Growth) — Acquisition → Time-to-Value → Activation → " +
        "    Habit → Expansion → Advocacy. Good for self-serve B2B with usage-based pricing. " +
        "  • JTBD (Jobs-to-be-Done) — Job Started → Job Progress → Job Completed → Job Abandoned, " +
        "    with job_type property. Good for tool-shaped products (calculators, generators, IDEs). " +
        "  • API / Developer Tool — api_call_made (with endpoint, status, latency, token_id), " +
        "    key_minted, key_rotated, rate_limit_hit, quota_exceeded. " +
        "  • Marketplace Two-Sided — same lens (AARRR or PLG) applied separately to supply (sellers, " +
        "    creators) and demand (buyers, viewers), tracked with `side: 'supply' | 'demand'` property. " +
        "(3) what are the 10-20 user actions that matter most for THIS app specifically " +
        "(use the chosen lens as a checklist, but the actual event names should match THIS " +
        "product's vocabulary — not a generic 'feature_used'). " +
        "(4) where does money flow — every signup, upgrade, downgrade, cancellation, refund, " +
        "payment success/failure should have a tracked event. If the app isn't monetized yet, " +
        "still track the equivalent value-moments (e.g. for an open-source project: " +
        "star_added, contributor_first_pr, sponsor_added). " +
        "(5) what external services does it depend on and where can they fail. " +
        "(6) which entities have lifecycles (create / update / delete / state-transition) worth tracking. " +
        "Write the category + framework choice + event inventory to agentry_memory.md so the " +
        "instrumentation that follows is grounded in THIS app, not a generic template.",
    },
    {
      id: "set_env_vars",
      title: isClient
        ? "Expose AGENTRY_DSN and AGENTRY_URL to the client bundle (build-time injection)"
        : "Set AGENTRY_DSN, AGENTRY_URL, and GIT_SHA in the runtime environment",
      why: isClient
        ? "agentry has NO SDK — you talk to it via raw HTTP. The DSN authenticates each POST; " +
          "URL points at the agentry deployment. The DSN must be injected at build time " +
          "(NEXT_PUBLIC_AGENTRY_DSN, VITE_AGENTRY_DSN, REACT_APP_AGENTRY_DSN). " +
          "Yes the DSN appears in the bundle — that's intentional. It only grants ingest, never reads."
        : "agentry has NO SDK — you talk to it via raw HTTP. DSN authenticates each POST; " +
          "URL points at the agentry deployment. GIT_SHA links each event to the deploy that emitted it.",
      action: "manual",
      file_hint: isClient
        ? "Vercel env / Vite .env / Webpack DefinePlugin / Next.js env settings — " +
          "use the framework's standard PUBLIC_ prefix for client-exposed vars."
        : "Set in .env / Vercel env / Railway env / docker-compose / wherever your app reads env from at runtime. " +
          "AGENTRY_URL example: https://api.agentry.sh",
      validate: isClient
        ? "After build, grep your client bundle for the DSN — it should be present (it's a public token, not a secret)."
        : "process.env.AGENTRY_DSN, process.env.AGENTRY_URL should be defined inside the running app. " +
          "GIT_SHA should be the actual current git SHA (in CI: $(git rev-parse HEAD); on Vercel: VERCEL_GIT_COMMIT_SHA).",
    },
    {
      id: "drop_in_agentry_helper",
      title: isClient
        ? "Drop in a tiny agentry helper (client-side, native fetch)"
        : "Drop in a tiny agentry helper (server-side, native fetch)",
      why:
        "agentry is just three POST endpoints (/v1/logs/, /v1/analytics/, /v1/deploys/) " +
        "with the same DSN auth. No SDK to install, no agentry-named dependency to vet. " +
        "Drop in this ~20-line wrapper once and use it everywhere.",
      action: "edit",
      file_hint: isClient
        ? "Create src/lib/agentry.ts (or wherever your client shared utils live)."
        : "Create src/lib/agentry.ts (or wherever your server shared utils live).",
      code: isClient
        ? `// src/lib/agentry.ts — client-side helper, native fetch, no dependencies.
const URL = import.meta.env?.VITE_AGENTRY_URL
         ?? process.env.NEXT_PUBLIC_AGENTRY_URL
         ?? process.env.REACT_APP_AGENTRY_URL!;
const DSN = import.meta.env?.VITE_AGENTRY_DSN
         ?? process.env.NEXT_PUBLIC_AGENTRY_DSN
         ?? process.env.REACT_APP_AGENTRY_DSN!;
const PID = DSN.split("_")[1].split(".")[0];

type Kind = "logs" | "analytics" | "deploys";

export function agentry(kind: Kind, payload: object): void {
  // Fire-and-forget. Use sendBeacon on visibilitychange='hidden' for reliability.
  const body = JSON.stringify(payload);
  if (kind === "analytics" && typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon(\`\${URL}/v1/\${kind}/\${PID}/\`, new Blob([body], { type: "application/json" }));
    return;
  }
  fetch(\`\${URL}/v1/\${kind}/\${PID}/\`, {
    method: "POST",
    headers: { authorization: \`Bearer \${DSN}\`, "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {}); // never let monitoring crash the page
}

export function captureError(err: unknown, extra?: object): void {
  const e = err instanceof Error ? err : new Error(String(err));
  agentry("logs", {
    name: e.name, message: e.message, stack: e.stack,
    user: { id: getDistinctId() },
    tags: { url: location.href, ua: navigator.userAgent },
    extra,
  });
}

function getDistinctId(): string {
  let id = localStorage.getItem("agentry_did");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("agentry_did", id); }
  return id;
}`
        : `// src/lib/agentry.ts — server-side helper, native fetch (Node 20+), no dependencies.
const URL = process.env.AGENTRY_URL!;
const DSN = process.env.AGENTRY_DSN!;
const PID = DSN.split("_")[1].split(".")[0];
const GIT_SHA = process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";
const ENV = process.env.NODE_ENV ?? "production";

type Kind = "logs" | "analytics" | "deploys";

export async function agentry(kind: Kind, payload: object): Promise<void> {
  try {
    await fetch(\`\${URL}/v1/\${kind}/\${PID}/\`, {
      method: "POST",
      headers: { authorization: \`Bearer \${DSN}\`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch { /* never let monitoring crash the request */ }
}

export function captureError(err: unknown, extra?: object): Promise<void> {
  const e = err instanceof Error ? err : new Error(String(err));
  return agentry("logs", {
    name: e.name, message: e.message, stack: e.stack,
    environment: ENV, deploy_sha: GIT_SHA,
    extra,
  });
}

export function track(
  event: string,
  distinct_id: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  return agentry("analytics", { event, distinct_id, properties });
}`,
      validate:
        "The helper exports a callable agentry() function. Calling it with a test payload " +
        "should not throw and should hit the agentry API (check 200 in your network panel " +
        "or wrangler tail on the agentry deployment).",
    },
  ];
}

function clientErrorCaptureSteps(framework: Framework): InstallGuideStep[] {
  const steps: InstallGuideStep[] = [
    {
      id: "wire_global_error_listeners",
      title: "Wire window 'error' and 'unhandledrejection' to captureError",
      why:
        "Global listeners catch the long tail of uncaught errors thrown anywhere in your app — " +
        "from third-party scripts, async callbacks, promise rejections. Without these, you only " +
        "see errors that happen to bubble through your framework's error boundary.",
      action: "edit",
      file_hint:
        framework === "react"
          ? "Top of src/main.tsx (or wherever your app boots), AFTER importing the helper."
          : framework === "next-client"
          ? "app/agentry.client.ts — a 'use client' module imported once from app/layout.tsx."
          : "Top of your client entrypoint.",
      code: `import { captureError } from "@/lib/agentry";

if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => captureError(e.error ?? e.message, { source: "window.error" }));
  window.addEventListener("unhandledrejection", (e) => captureError(e.reason, { source: "unhandledrejection" }));
}`,
      validate:
        "Throw `setTimeout(() => { throw new Error('smoke') }, 100)` from the console. " +
        "A case with name='Error' message='smoke' should appear in agentry_list_cases within ~5s.",
    },
  ];

  if (framework === "react" || framework === "next-client") {
    steps.push({
      id: "react_error_boundary",
      title: "Capture React render errors via an ErrorBoundary (the global handler doesn't catch these)",
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
import { captureError } from "@/lib/agentry";

export class AgentryErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: { componentStack?: string }) {
    captureError(error, { source: "react_error_boundary", componentStack: info.componentStack });
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
import { captureError } from "@/lib/agentry";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => { captureError(error, { source: "next_error_boundary" }); }, [error]);
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
      id: "track_page_view_with_attribution",
      title: "Track page_view on every route change — capture acquisition attribution properties",
      why:
        "Page views are the top of every funnel. CRUCIALLY: on the FIRST page_view of a session, " +
        "capture every attribution property you can find — utm_source, utm_medium, utm_campaign, " +
        "referrer, landing_path. You cannot reconstruct 'where did our paying users come from' " +
        "later if you didn't capture this at first-touch.",
      action: "edit",
      file_hint:
        framework === "react"
          ? "Listen on react-router or wouter route changes. Pull utm params from window.location.search on the FIRST event."
          : framework === "next-client"
          ? "app/agentry-router-tracker.tsx — a 'use client' component using usePathname() + useSearchParams()."
          : "On every route change in your client router. Capture utm params from the URL search string.",
      code:
        framework === "next-client"
          ? `"use client";
import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { track } from "@/lib/agentry";

function getOrCreateDistinctId(): string {
  let id = localStorage.getItem("agentry_did");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("agentry_did", id); }
  return id;
}

export function AgentryRouterTracker() {
  const path = usePathname();
  const params = useSearchParams();
  const isFirst = useRef(true);

  useEffect(() => {
    const did = getOrCreateDistinctId();
    const properties: Record<string, unknown> = { path };
    if (isFirst.current) {
      // First-touch attribution: capture acquisition only on first page_view
      properties.referrer = document.referrer || null;
      properties.utm_source = params.get("utm_source");
      properties.utm_medium = params.get("utm_medium");
      properties.utm_campaign = params.get("utm_campaign");
      properties.landing_path = path;
      isFirst.current = false;
    }
    track("page_view", did, properties);
  }, [path, params]);

  return null;
}

// Mount once in app/layout.tsx.`
          : `import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { track } from "@/lib/agentry";

function getOrCreateDistinctId(): string {
  let id = localStorage.getItem("agentry_did");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("agentry_did", id); }
  return id;
}

export function PageViewTracker() {
  const loc = useLocation();
  const isFirst = useRef(true);

  useEffect(() => {
    const did = getOrCreateDistinctId();
    const properties: Record<string, unknown> = { path: loc.pathname };
    if (isFirst.current) {
      const usp = new URLSearchParams(loc.search);
      properties.referrer = document.referrer || null;
      properties.utm_source = usp.get("utm_source");
      properties.utm_medium = usp.get("utm_medium");
      properties.utm_campaign = usp.get("utm_campaign");
      properties.landing_path = loc.pathname;
      isFirst.current = false;
    }
    track("page_view", did, properties);
  }, [loc.pathname]);

  return null;
}`,
      validate:
        "Visit `https://yourapp.com/?utm_source=test&utm_campaign=smoke`. " +
        "The first page_view in PostHog should have utm_source='test'. Subsequent route " +
        "changes should NOT carry utm props (they were a first-touch property).",
    },
    {
      id: "track_client_interactions_broadly",
      title: "Track every meaningful CTA, form submit, paywall view — broadly, not minimally",
      why:
        "Server-side analytics misses ~30% of events to ad-blockers AND every pre-submission " +
        "intent signal (clicks on CTAs that didn't convert, form abandonment, paywall views without " +
        "upgrade). These are the events that explain WHY funnel drops happen. Track widely now; " +
        "the agent can ignore noisy ones at query time.",
      action: "edit",
      file_hint:
        "onClick / onSubmit handlers for: hero/feature CTAs, signup form fields (each step), " +
        "paywall views, feature flag exposures, video plays, modal opens, share clicks. " +
        "Track INTENT (clicked) and OUTCOME (converted) separately.",
      code: `import { track } from "@/lib/agentry";

const did = localStorage.getItem("agentry_did")!;

// CTAs — intent signals (these never reach the server otherwise)
<button onClick={() => {
  track("cta_clicked", did, { cta_id: "hero_signup", page: location.pathname, variant: "v2" });
}}>Sign up</button>

// Signup funnel — every step, not just completion
track("signup_form_started", did, { variant: "v2" });
track("signup_form_field_blurred", did, { field: "email" });
track("signup_form_submitted", did, { variant: "v2" });

// Paywall + upgrade intent
track("paywall_viewed", did, { reason: "feature_locked", feature: "team_members", current_plan: "free" });
track("upgrade_clicked", did, { from_plan: "free", to_plan: "pro", source: "paywall" });

// Feature exposure (helps the agent see which features users discover)
track("feature_used", did, { feature: "export_csv", first_use: true });
track("modal_opened", did, { modal: "invite_team" });
track("share_clicked", did, { surface: "project_view", target: "twitter" });`,
      validate:
        "Click 5+ different tracked controls. Each should appear in PostHog within ~10s. " +
        "Confirm CTA clicks land even when they don't convert to a server-side action.",
    },
  ];
}

function errorCaptureSteps(framework: Framework): InstallGuideStep[] {
  const steps: InstallGuideStep[] = [
    {
      id: "wire_process_error_listeners",
      title: "Wire uncaughtException and unhandledRejection to captureError",
      why:
        "Process-level handlers catch errors that escape your framework — top-level await throwers, " +
        "callback errors, unhandled promise rejections. Register them once, as early as possible " +
        "(before route imports, before app.listen()).",
      action: "edit",
      file_hint:
        framework === "next"
          ? "Create or edit instrumentation.ts at the project root. Next.js calls this once before any other code."
          : framework === "express"
          ? "Top of your main server file (index.ts / server.ts / app.ts) — BEFORE app.listen() and BEFORE any route imports."
          : "Top of your main entrypoint file — first lines, AFTER importing the helper.",
      code:
        framework === "next"
          ? `// instrumentation.ts (Next.js calls this once on server start)
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { captureError } = await import("@/lib/agentry");
    process.on("uncaughtException", (err) => captureError(err, { uncaught: true }));
    process.on("unhandledRejection", (err) => captureError(err, { unhandled: true }));
  }
}`
          : `import { captureError } from "@/lib/agentry";

process.on("uncaughtException", (err) => captureError(err, { uncaught: true }));
process.on("unhandledRejection", (err) => captureError(err, { unhandled: true }));`,
      validate:
        "Throw `setTimeout(() => { throw new Error('smoke') }, 100)` from your entrypoint in dev. " +
        "A case should appear in agentry_list_cases within ~5s.",
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
      code: `import { captureError } from "@/lib/agentry";
import type { Request, Response, NextFunction } from "express";

// ... after all routes are registered ...
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  captureError(err, {
    framework: "express",
    method: req.method,
    url: req.url,
    headers: scrubHeaders(req.headers),
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
import { captureError } from "@/lib/agentry";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => { captureError(error, { source: "next_error_boundary" }); }, [error]);
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
      id: "track_comprehensively_for_this_app",
      title: "Instrument THIS app comprehensively — use the chosen lens as a checklist, with rich properties",
      why:
        "The agent can only investigate what you tracked. If you didn't capture an event 3 " +
        "months ago, no question about it is answerable today. The fix: cover every layer of " +
        "your chosen metrics lens (AARRR for most SaaS / consumer / marketplace / e-commerce; " +
        "DAU + cohort retention for games; API call volume + endpoint usage for dev tools; " +
        "lead → close + contract value for enterprise sales; adoption + task success for " +
        "internal tools) — but use THIS app's actual vocabulary for event names. " +
        "Don't blindly paste generic template events. Take the inventory from " +
        "investigate_app_structure, walk through it, and translate each item into a specific " +
        "track() call. " +
        "Over-track now — storage is cheap; missing data is unrecoverable. The agent can " +
        "filter noisy events at query time; it can't invent missing ones. " +
        "RULE: every event should carry as many properties as you can reasonably attach " +
        "(plan, source, variant, ids, counts, timing, feature flags). Properties are how the " +
        "agent slices the data when you ask it questions later.",
      action: "edit",
      file_hint:
        "Walk the codebase systematically using the inventory from 'investigate_app_structure'. " +
        "For each entry in your inventory, add a track() call with rich properties. " +
        "Use the helper from drop_in_agentry_helper: `import { track } from '@/lib/agentry'`. " +
        "Server-side tracks (the action persists data) are AUTHORITATIVE; client-side tracks " +
        "fill the funnel above the server boundary (intent, exposure, abandonment). " +
        "If you chose AARRR, the examples below are a starting checklist — rename and adapt " +
        "to match THIS product. If you chose a different lens, structure your events around " +
        "its stages instead (the agent reading this is smart enough to translate).",
      code: `// ============================================================
// ACQUISITION — where users come from
// ============================================================
// Note: first-touch attribution is captured client-side on first page_view.
// Server-side, capture attribution at the moment of conversion (signup).

await track("signup_completed", newUser.id, {
  method: "github",                    // github / email / google / sso
  plan: "free",
  // First-touch attribution — read from session/cookie set at landing
  utm_source: session.utm_source,
  utm_medium: session.utm_medium,
  utm_campaign: session.utm_campaign,
  referrer: session.referrer,
  landing_path: session.landing_path,
  // Behavioral signals
  signup_duration_ms: Date.now() - session.first_seen_at,
  pages_before_signup: session.page_views,
});

// ============================================================
// ACTIVATION — first happy experience
// ============================================================
// Track the entire onboarding flow at fine granularity, plus the
// activation moment (whatever your product's first-value-action is).

await track("onboarding_step_started",   user.id, { step: "create_workspace", step_index: 1 });
await track("onboarding_step_completed", user.id, { step: "create_workspace", step_index: 1, duration_ms: 8400 });
await track("onboarding_skipped",        user.id, { step: "invite_team", step_index: 3 });
await track("onboarding_completed",      user.id, { duration_ms: 142_000, steps_done: 5, steps_skipped: 1 });

// Activation milestone — the moment the user gets value. Define this once per product.
await track("activated", user.id, {
  activation_type: "first_export",       // first_message_sent / first_project_published / etc
  time_to_activation_ms: Date.now() - user.created_at.getTime(),
  plan: user.plan,
});

// ============================================================
// RETENTION — do they come back? engagement signals
// ============================================================
await track("session_started", user.id, { workspace_id: w.id, device: "desktop", platform: "web" });
await track("daily_active",    user.id, { plan: user.plan, days_since_signup: 14 });

// Entity lifecycle — every meaningful noun in your product
await track("project_created",   user.id, { template_id: t?.id, workspace_id: w.id });
await track("project_updated",   user.id, { project_id: p.id, fields_changed: ["name", "visibility"] });
await track("project_published", user.id, { project_id: p.id, visibility: "public" });
await track("project_archived",  user.id, { project_id: p.id, days_active: 47 });
await track("project_deleted",   user.id, { project_id: p.id, days_active: 14 });

// Feature usage — every meaningful feature, not just the headline ones
await track("feature_used",            user.id, { feature: "export_csv", first_use: true });
await track("integration_connected",   user.id, { provider: "slack", scopes: ["chat:write"] });
await track("integration_disconnected", user.id, { provider: "slack", days_connected: 23 });
await track("integration_error",       user.id, { provider: "slack", error: "token_revoked" });

// ============================================================
// REFERRAL — virality and team growth
// ============================================================
await track("invite_sent",            inviter.id, { invitee_email_hash: hash(email), workspace_id: w.id, role: "member" });
await track("invite_accepted",        invitee.id, { workspace_id: w.id, invited_by: inviter.id });
await track("invite_expired",         inviter.id, { invitee_email_hash: hash(email), days_open: 7 });
await track("share_link_created",     user.id,    { resource_type: "project", resource_id: p.id, expires_at: null });
await track("share_link_visited",     visitor.id, { resource_type: "project", resource_id: p.id, viewer_is_signed_in: false });
await track("public_link_signup",     newUser.id, { from_resource_type: "project", from_resource_id: p.id });

// ============================================================
// REVENUE — the highest-value events. Track EVERY state transition.
// ============================================================
// Money events are the most painful to miss retroactively. You CANNOT
// reconstruct historical MRR, cohorts, or churn rates if these weren't
// tracked at the time. Capture them now even if you're not building a
// billing dashboard today.

await track("trial_started",          user.id, { plan: "pro", trial_days: 14, source: "paywall" });
await track("trial_ended",            user.id, { plan: "pro", converted: false, days_used: 14 });
await track("plan_selected",          user.id, { plan: "pro", billing_cycle: "monthly", source: "pricing_page" });
await track("checkout_started",       user.id, { plan: "pro", amount_cents: 1900, currency: "usd" });
await track("payment_method_added",   user.id, { type: "card", brand: "visa", last4: "4242" });
await track("payment_succeeded",      user.id, { amount_cents: 1900, currency: "usd", invoice_id: inv.id });
await track("payment_failed",         user.id, { amount_cents: 1900, reason: "card_declined", attempt: 1 });
await track("subscription_created",   user.id, { plan: "pro", amount_cents: 1900, billing_cycle: "monthly" });
await track("subscription_upgraded",  user.id, { from_plan: "free", to_plan: "pro", mrr_delta_cents: 1900 });
await track("subscription_downgraded", user.id, { from_plan: "pro", to_plan: "free", mrr_delta_cents: -1900 });
await track("subscription_renewed",   user.id, { plan: "pro", amount_cents: 1900, renewal_count: 4 });
await track("subscription_canceled",  user.id, { plan: "pro", reason_code: "too_expensive", days_active: 47 });
await track("subscription_reactivated", user.id, { plan: "pro", days_churned: 12 });
await track("refund_issued",          user.id, { amount_cents: 1900, reason: "user_request" });
await track("dunning_email_sent",     user.id, { attempt: 1, days_overdue: 3 });`,
      validate:
        "After this step you should have 25+ distinct event names tracked across all 5 AARRR layers. " +
        "Run a real session: signup → onboard → use a feature → invite a teammate → upgrade. " +
        "Every meaningful step should have produced events. " +
        "Run `agentry_run_recipe(funnel_3_step)` to confirm funnel queries work. " +
        "Then ask your agent: 'where are users dropping off?' — the answer should be specific (a particular step), not 'we don't have data for that yet'.",
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
      -A "agentry-ci/1.0" \\
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
        "agentry_verify_install must report ✅ for logs, analytics, and deploys. " +
        "If any signal is ❌, the corresponding step above is wrong — re-read its `validate` field and fix.",
    },
  ];
}

// Final step: once events are flowing, surface high-value next builds.
// This is the bridge from "install complete" to "now go build something with it".
// The point: the agent should inspect what's actually being tracked and propose
// 3-5 specific things to build that match THIS app's instrumentation — not a
// generic "here's a dashboard idea" list.
function suggestNextBuildsStep(): InstallGuideStep {
  return {
    id: "suggest_next_builds",
    title: "Suggest 3-5 dashboards / automations to build NEXT, grounded in what's actually tracked",
    why:
      "Once events are flowing, the user has data but no surface yet. Agentry doesn't ship the " +
      "dashboard — the agent does. Don't wait for the user to ask 'now what?'; proactively " +
      "surface the highest-value things to build given the events that are now being captured. " +
      "Use the inventory from investigate_app_structure + the events you instrumented in the " +
      "analytics step. Match each suggestion to events that ACTUALLY exist — not aspirational " +
      "ones. Surface them as a numbered list with a short why + the agentry MCP tool that " +
      "would build it.",
    action: "manual",
    file_hint:
      "Don't edit any code yet — this is a planning step. Read agentry_memory.md to recall the " +
      "app's category, framework choice, and event inventory. Use agentry_suggested_next_steps " +
      "as a starting point, then refine to THIS app's shape. " +
      "" +
      "The MENU of high-leverage builds — pick the 3-5 that match the events being captured: " +
      "" +
      "  DASHBOARDS (admin routes the agent writes into the customer's repo): " +
      "  • Funnel visualization dashboard — pick the product's primary funnel (signup → activation, " +
      "    or page_view → purchase, etc.), show each step with conversion + drop-off %s, split by " +
      "    a useful dimension (device, plan, cohort, utm_source). Uses agentry_run_recipe(funnel_3_step). " +
      "    REQUIRES: ≥3 sequential events instrumented. " +
      "  • Bug fix dashboard — list open Cases with status, event count, affected users, last-seen, " +
      "    last-deploy SHA, and PR link if the agent's opened one. Uses agentry_list_cases + agentry_get_case. " +
      "    REQUIRES: log/error events flowing. " +
      "  • MRR / Revenue dashboard — current MRR, week-over-week growth, churn rate, expansion " +
      "    revenue, new MRR by signup cohort. Uses ad-hoc HogQL via agentry_analytics_query. " +
      "    REQUIRES: subscription / payment events. " +
      "  • Cohort retention curve — weekly cohorts down the side, weeks-since-signup across the " +
      "    top, % retained at each cell. Uses agentry_run_recipe(weekly_retention). " +
      "    REQUIRES: signup_completed + any recurring engagement event (session_started / daily_active). " +
      "  • Top users / power workspaces — leaderboard of who's using the product most (and who's " +
      "    triggering the most errors). Uses agentry_run_recipe(top_users_by_errors) + analytics query. " +
      "    REQUIRES: distinct_id on tracked events. " +
      "  • DAU / MAU + stickiness — DAU and MAU over the last 30 days, DAU/MAU ratio, trend. " +
      "    Uses agentry_run_recipe(active_users_daily) + ad-hoc HogQL. " +
      "    REQUIRES: a daily-active event (page_view, session_started, daily_active). " +
      "  • Feature adoption matrix — for each feature, what % of MAU has used it. Surfaces dead " +
      "    features and under-discovered ones. " +
      "    REQUIRES: feature_used (or feature-specific) events. " +
      "  • Deploy health dashboard — last N deploys with error spike attribution (did errors go " +
      "    up after this deploy?), affected users. Uses agentry_run_recipe(errors_after_last_deploy). " +
      "    REQUIRES: deploy events. " +
      "  • Onboarding completion funnel — per onboarding step, % completed, % skipped, time-to- " +
      "    next-step. Shows where new users get stuck. " +
      "    REQUIRES: onboarding_step_* events. " +
      "  • Acquisition channel report — signups grouped by utm_source/medium/campaign, with " +
      "    conversion-to-paid rate per channel. Tells you where to spend more marketing. " +
      "    REQUIRES: first-touch utm attribution on signup_completed. " +
      "  • Virality / k-factor dashboard — invites_sent → invites_accepted → first-action-by- " +
      "    invitee. Tells you if the product is self-propagating. " +
      "    REQUIRES: invite_sent / invite_accepted events. " +
      "" +
      "  AUTOMATIONS (cron + webhooks, NO admin UI needed): " +
      "  • Auto-fix pipeline — every 10 min: list_cases(open) → agent investigates top case → " +
      "    proposes fix → opens PR via gh CLI. Uses agentry_register_webhook(case.created) + " +
      "    a Cloudflare Worker / GitHub Action consumer. The highest-leverage automation. " +
      "    REQUIRES: log/error events. " +
      "  • Real-time error alert — Slack ping when errors_per_hour > threshold, including " +
      "    the case fingerprint, affected users, and a link to the case. " +
      "    Uses agentry_create_alert + agentry_register_webhook. " +
      "    REQUIRES: log events. " +
      "  • Deploy regression alert — auto-detect when error rate spikes within N minutes of a " +
      "    new deploy, alert with the suspect commit SHA. " +
      "    REQUIRES: log + deploy events. " +
      "  • Weekly Slack digest — every Monday 9am, post DAU/signups/MRR/top-bug for the prior " +
      "    week. Uses cron + agentry_run_recipe(weekly_digest pattern). " +
      "    REQUIRES: enough events for the chosen lens (AARRR-style). " +
      "  • Churn early-warning — fires when a paying user's daily_active drops to 0 for N days. " +
      "    Pings the CS team with that user's recent activity timeline. " +
      "    REQUIRES: daily_active or session_started events + subscription events. " +
      "  • Stripe webhook → agentry mirror — sync every Stripe event (charge.succeeded, " +
      "    customer.subscription.updated, etc.) as a tracked analytics event. Avoids lossy " +
      "    'we don't have the data' answers later. " +
      "    REQUIRES: Stripe (or other payment provider) webhook endpoint. " +
      "  • Activation drop-off notifier — DM users (or their CS rep) when they stall mid- " +
      "    onboarding for > X hours. " +
      "    REQUIRES: onboarding_step_* events with distinct_id + email. " +
      "" +
      "DON'T propose dashboards for events that aren't being captured — that's how customers " +
      "lose trust in the agent. Verify each suggestion against the actual event inventory before " +
      "presenting it.",
    validate:
      "Present the user with 3-5 concrete suggestions from the menu above. Each must include: " +
      "(a) the dashboard/automation name, " +
      "(b) the specific events it depends on (must exist in this app's instrumentation), " +
      "(c) what question it answers in one sentence, " +
      "(d) the agentry tool(s) that would build it (e.g. `agentry_run_recipe(funnel_3_step)` + " +
      "    `Write(src/pages/admin/funnel.astro)`, or `agentry_create_alert` + " +
      "    `agentry_register_webhook` + a small Cloudflare Worker). " +
      "Ask the user to pick which to build first. " +
      "If the user has no preference, default to the highest-leverage trio of: " +
      "(1) auto-fix pipeline for new errors (drains the bug backlog automatically), " +
      "(2) funnel visualization dashboard for the product's primary value-action " +
      "    (tells you where users drop off), " +
      "(3) weekly Slack digest in the chosen lens's shape (keeps the team informed without " +
      "    anyone having to open a dashboard).",
  };
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
  const wantsLogs = signalTypes.has("logs");
  const wantsAnalytics = signalTypes.has("analytics");

  const sections: string[] = [];

  if (wantsLogs) {
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
      (wantsLogs ? "what error data is captured (stack, URL, deploy version), " : "") +
      (wantsAnalytics ? "what analytics events are captured (page views, key actions, identifier), " : "") +
      "and the agentry.sh link should resolve.",
  };
}

export function buildInstallGuide(framework: Framework, signalTypes: string[]): InstallGuide {
  const wantedSet = new Set(signalTypes.length ? signalTypes : ["logs", "analytics", "deploys"]);

  // Direct-HTTP languages get a separate, simpler builder.
  if (isHttpFramework(framework)) {
    return buildHttpGuide(framework, wantedSet);
  }

  const steps: InstallGuideStep[] = [...commonSteps(framework)];
  const isClient = isClientFramework(framework);

  if (wantedSet.has("logs")) {
    steps.push(...(isClient ? clientErrorCaptureSteps(framework) : errorCaptureSteps(framework)));
  }
  if (wantedSet.has("analytics")) {
    steps.push(...(isClient ? clientAnalyticsSteps(framework) : analyticsSteps(framework)));
  }
  // Deploy events are CI-side, never client-side.
  if (wantedSet.has("deploys") && !isClient) steps.push(...deploySteps(framework));

  // Privacy policy update — only when we're capturing user-affecting data.
  if (wantedSet.has("logs") || wantedSet.has("analytics")) {
    steps.push(privacyPolicyStep(framework, wantedSet));
  }

  steps.push(...verifySteps());
  steps.push(suggestNextBuildsStep());

  const pitfalls = isClient
    ? [
        "DSNs in client bundles are public tokens, not secrets — they only grant ingest. Don't be alarmed when you see yours in DevTools.",
        "Keep server-side and client-side helpers separate. The client helper uses sendBeacon + browser APIs; the server helper uses Node fetch. Don't import the client helper from a server route handler (or vice versa).",
        "Source maps: in production builds, stack traces will reference minified filenames. Source-map upload is a v0.x feature; for now, agents can still match by error message + URL.",
        "Don't track sensitive form values in event properties. Track that the action happened, not what was entered.",
        "On mobile Safari, fetch may fail silently during page transitions — fall back to navigator.sendBeacon on visibilitychange='hidden' (already in the suggested helper).",
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

def send(kind, payload):
    """kind: 'logs' | 'analytics' | 'deploys'. Auto-serializes exceptions into logs."""
    try:
        if isinstance(payload, BaseException):
            kind = "logs"
            payload = {
                "name": type(payload).__name__,
                "message": str(payload),
                "stack": "".join(traceback.format_exception(type(payload), payload, payload.__traceback__)),
            }
        requests.post(
            f"{AGENTRY_URL}/v1/{kind}/{PROJECT_ID}/",
            headers={
                "authorization": f"Bearer {AGENTRY_DSN}",
                "content-type": "application/json",
                # MUST set a custom User-Agent. Cloudflare's Browser Integrity Check
                # 403s default urllib/curl/python-urllib UAs with CF error 1010.
                "user-agent": "agentry-python/1.0",
            },
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
        "Call agentry.send('errors', exc). Set AGENTRY_DSN and AGENTRY_URL env vars.",
      code: `# Flask example
from flask import Flask
import agentry

app = Flask(__name__)

@app.errorhandler(Exception)
def handle_all(exc):
    agentry.send("logs", exc)
    raise exc

# Track an analytics event:
agentry.send("analytics", {"event": "signup_completed", "distinct_id": user_id, "properties": {"plan": "free"}})

# Record a deploy from CI / startup:
agentry.send("deploys", {"sha": os.environ["GIT_SHA"], "environment": "production"})`,
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

  # kind: 'logs' | 'analytics' | 'deploys'. Auto-serializes exceptions into logs.
  def self.send(kind, payload)
    if payload.is_a?(Exception)
      kind = "logs"
      payload = {
        name: payload.class.name,
        message: payload.message,
        stack: payload.backtrace&.join("\\n"),
      }
    end
    uri = URI("#{URL}/v1/#{kind}/#{PROJECT_ID}/")
    # MUST set a custom User-Agent. Cloudflare's Browser Integrity Check 403s
    # default Ruby Net::HTTP UAs ('Ruby') with CF error 1010.
    req = Net::HTTP::Post.new(uri,
      "authorization" => "Bearer #{DSN}",
      "content-type" => "application/json",
      "user-agent" => "agentry-ruby/1.0",
    )
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
    Agentry.send("logs", e)
    raise e
  end
end

# Track an event:
Agentry.send("analytics", event: "signup_completed", distinct_id: current_user.id, properties: { plan: "free" })

# Record a deploy:
Agentry.send("deploys", sha: ENV["GIT_SHA"], environment: "production")`,
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

// Send to agentry. kind: "logs" | "analytics" | "deploys".
// Auto-serializes errors with stack; everything else sent verbatim.
func Send(kind string, payload any) {
    if err, ok := payload.(error); ok {
        kind = "logs"
        payload = map[string]any{
            "name":    fmt.Sprintf("%T", err),
            "message": err.Error(),
            "stack":   string(debug.Stack()),
        }
    }
    body, _ := json.Marshal(payload)
    req, _ := http.NewRequest("POST", url+"/v1/"+kind+"/"+projectID+"/", bytes.NewReader(body))
    req.Header.Set("authorization", "Bearer "+dsn)
    req.Header.Set("content-type", "application/json")
    // MUST set a custom User-Agent. Cloudflare's Browser Integrity Check 403s
    // default Go net/http UAs ('Go-http-client/1.1') with CF error 1010.
    req.Header.Set("user-agent", "agentry-go/1.0")
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
                    agentry.Send("logs", err)
                } else {
                    agentry.Send("logs", map[string]any{"message": fmt.Sprint(rec)})
                }
                http.Error(w, "internal", 500)
            }
        }()
        next.ServeHTTP(w, r)
    })
}

// Track:
agentry.Send("analytics", map[string]any{"event": "signup_completed", "distinct_id": userID})

// Deploy:
agentry.Send("deploys", map[string]any{"sha": os.Getenv("GIT_SHA"), "environment": "production"})`,
    },
  },
  php: {
    language_human: "PHP",
    helper_file_hint: "src/Agentry.php (PSR-4 compatible).",
    helper_code: `<?php
// src/Agentry.php
class Agentry {
    /** @param string $kind 'logs' | 'analytics' | 'deploys' */
    public static function send(string $kind, mixed $payload): void {
        $url = getenv("AGENTRY_URL");
        $dsn = getenv("AGENTRY_DSN");
        $projectId = explode(".", explode("_", $dsn, 2)[1], 2)[0];

        if ($payload instanceof \\Throwable) {
            $kind = "logs";
            $payload = [
                "name" => get_class($payload),
                "message" => $payload->getMessage(),
                "stack" => $payload->getTraceAsString(),
            ];
        }
        $ch = curl_init("$url/v1/$kind/$projectId/");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            // user-agent MUST be set — Cloudflare's BIC 403s defaults with CF error 1010.
            CURLOPT_HTTPHEADER => [
                "authorization: Bearer $dsn",
                "content-type: application/json",
                "user-agent: agentry-php/1.0",
            ],
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
    Agentry::send("logs", $e);
    parent::report($e);
}

// Track:
Agentry::send("analytics", ["event" => "signup_completed", "distinct_id" => $userId]);

// Deploy:
Agentry::send("deploys", ["sha" => getenv("GIT_SHA"), "environment" => "production"]);`,
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

    /** kind: "logs" | "analytics" | "deploys" */
    public static void send(String kind, Object payload) {
        try {
            if (payload instanceof Throwable t) {
                kind = "logs";
                StringWriter sw = new StringWriter();
                t.printStackTrace(new PrintWriter(sw));
                payload = Map.of("name", t.getClass().getName(),
                    "message", String.valueOf(t.getMessage()), "stack", sw.toString());
            }
            HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(URL + "/v1/" + kind + "/" + PROJECT_ID + "/"))
                .header("authorization", "Bearer " + DSN)
                .header("content-type", "application/json")
                // MUST set a custom User-Agent. Cloudflare's Browser Integrity
                // Check 403s default Java HttpClient UAs with CF error 1010.
                .header("user-agent", "agentry-java/1.0")
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
        Agentry.send("logs", e);
        return ResponseEntity.status(500).body("internal");
    }
}

// Plain Java startup:
Thread.setDefaultUncaughtExceptionHandler((thread, ex) -> Agentry.send("logs", ex));

// Track:  Agentry.send("analytics", Map.of("event", "signup_completed", "distinct_id", userId));
// Deploy: Agentry.send("deploys",   Map.of("sha", System.getenv("GIT_SHA"), "environment", "production"));`,
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

    /// <summary>kind: "logs" | "analytics" | "deploys"</summary>
    public static async Task Send(string kind, object payload) {
        try {
            if (payload is Exception ex) {
                kind = "logs";
                payload = new Dictionary<string, object?> {
                    ["name"] = ex.GetType().FullName,
                    ["message"] = ex.Message,
                    ["stack"] = ex.ToString(),
                };
            }
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{Url}/v1/{kind}/{ProjectId}/") {
                Content = JsonContent.Create(payload),
            };
            req.Headers.TryAddWithoutValidation("authorization", $"Bearer {Dsn}");
            // MUST set a custom User-Agent. Cloudflare's Browser Integrity
            // Check 403s default .NET HttpClient UAs with CF error 1010.
            req.Headers.TryAddWithoutValidation("user-agent", "agentry-dotnet/1.0");
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
    if (ex != null) await Agentry.Send("logs", ex);
    ctx.Response.StatusCode = 500;
    await ctx.Response.WriteAsync("internal");
}));

// Track:
await Agentry.Send("analytics", new { @event = "signup_completed", distinct_id = userId });

// Deploy:
await Agentry.Send("deploys", new { sha = Environment.GetEnvironmentVariable("GIT_SHA"), environment = "production" });`,
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

/// kind: "logs" | "analytics" | "deploys"
pub async fn send(kind: &str, payload: Value) {
    let url = env::var("AGENTRY_URL").unwrap_or_default();
    let dsn = env::var("AGENTRY_DSN").unwrap_or_default();
    let pid = project_id();
    let _ = reqwest::Client::new()
        .post(format!("{url}/v1/{kind}/{pid}/"))
        .bearer_auth(&dsn)
        // MUST set a custom User-Agent. Cloudflare's Browser Integrity Check
        // 403s some defaults with CF error 1010. reqwest's UA usually passes,
        // but setting it explicitly is defensive.
        .header("user-agent", "agentry-rust/1.0")
        .json(&payload)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;  // never crash the app
}

pub async fn send_error(err: &dyn std::error::Error) {
    send("logs", json!({
        "name": format!("{:?}", err),
        "message": err.to_string(),
        "stack": format!("{:?}", err),  // backtrace via std::backtrace::Backtrace if available
    })).await;
}`,
    error_handler: {
      file_hint:
        "Wrap your axum/actix routes with a panic-catching layer that calls agentry::send_error. " +
        "Or use std::panic::set_hook in main().",
      code: `// In main(), set a panic hook so unrecovered panics get reported:
std::panic::set_hook(Box::new(|info| {
    let msg = info.to_string();
    let _ = tokio::runtime::Handle::try_current().map(|h| {
        h.spawn(crate::agentry::send("logs", serde_json::json!({
            "name": "panic", "message": msg
        })));
    });
}));

// Track:  agentry::send("analytics", json!({"event": "signup_completed", "distinct_id": user_id})).await;
// Deploy: agentry::send("deploys",   json!({"sha": git_sha, "environment": "production"})).await;`,
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

  # kind: "logs" | "analytics" | "deploys"
  def send(kind, payload) do
    {kind, payload} = normalize(kind, payload)
    url = "#{@url}/v1/#{kind}/#{project_id()}/"
    # user-agent MUST be set — Cloudflare's BIC 403s defaults with CF error 1010.
    headers = [
      {"authorization", "Bearer #{@dsn}"},
      {"content-type", "application/json"},
      {"user-agent", "agentry-elixir/1.0"},
    ]
    body = Jason.encode!(payload)
    Task.start(fn -> :hackney.request(:post, url, headers, body, [recv_timeout: 5_000]) end)
    :ok
  end

  defp normalize(_kind, %{__exception__: true} = ex) do
    {"logs", %{name: ex.__struct__ |> Atom.to_string(), message: Exception.message(ex),
                 stack: Exception.format(:error, ex, __STACKTRACE__)}}
  end
  defp normalize(kind, other), do: {kind, other}
end`,
    error_handler: {
      file_hint:
        "Phoenix: a custom Plug.ErrorHandler. Plain: rescue blocks at top-level Task supervisors.",
      code: `# Phoenix endpoint.ex
plug Plug.ErrorHandler

defp handle_errors(_conn, %{kind: _kind, reason: reason, stack: _stack}) do
  Agentry.send("logs", reason)
end

# Track:
Agentry.send("analytics", %{event: "signup_completed", distinct_id: user.id, properties: %{plan: "free"}})

# Deploy:
Agentry.send("deploys", %{sha: System.get_env("GIT_SHA"), environment: "production"})`,
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

# Send to agentry. First arg: errors | analytics | deploys. Second: JSON payload.
agentry_send() {
  # -A sets User-Agent. Required: Cloudflare's BIC 403s default curl UAs in
  # some configurations with CF error 1010. Always set an explicit UA.
  curl -fsS -X POST "$AGENTRY_URL/v1/$1/$PROJECT_ID/" \\
    -A "agentry-shell/1.0" \\
    -H "authorization: Bearer $AGENTRY_DSN" \\
    -H "content-type: application/json" \\
    -d "$2" >/dev/null 2>&1 || true
}`,
    error_handler: {
      file_hint:
        "Anywhere a script can throw or a process exits non-zero. Wrap with 'trap' in bash, " +
        "or call agentry_send explicitly after \`|| true\` patterns to capture failures.",
      code: `# Bash trap on error
trap 'agentry_send errors "{\\"name\\":\\"BashError\\",\\"message\\":\\"line $LINENO failed: $BASH_COMMAND\\"}"' ERR

# Track an event:
agentry_send analytics '{"event": "cron_completed", "distinct_id": "etl-job-1", "properties": {"rows": 42}}'

# Record a deploy from CI:
agentry_send deploys '{"sha": "'"$GITHUB_SHA"'", "branch": "'"$GITHUB_REF_NAME"'", "environment": "production"}'`,
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

  steps.push({
    id: "investigate_app_structure",
    title: "Investigate the app structure BEFORE instrumenting anything",
    why:
      "agentry is only as useful as the events you send it. The wrong move is to slap a few " +
      "generic events on and ship — three months later you'll wish you'd tracked revenue, " +
      "or feature usage, or signup-flow drop-off, but the data isn't there. Spend 5-10 " +
      "minutes reading the codebase first so the instrumentation you add is comprehensive, " +
      "not boilerplate.",
    action: "manual",
    file_hint:
      "Read the dependency manifest (requirements.txt / Gemfile / go.mod / etc.) to confirm the framework. " +
      "Walk the source — note the route structure, the auth flow, the key user actions, " +
      "the integrations (payment provider, Slack, CRM, third-party APIs), background jobs, " +
      "and webhook endpoints. Look at the DB schema or ORM models — what entities exist " +
      "(users, subscriptions, workspaces, projects)? Each one's lifecycle is probably worth tracking. " +
      "Note where errors are caught and silently ignored — those are missing breadcrumbs.",
    validate:
      "You should be able to answer all of these before writing any agentry calls: " +
      "(1) what does this app do, in one sentence. " +
      "(2) what are the 5-15 user actions that matter most. " +
      "(3) where does money flow — every signup, upgrade, downgrade, cancellation, refund, " +
      "payment success/failure should have a tracked event. " +
      "(4) what external services does it depend on and where can they fail. " +
      "(5) which entities have lifecycles (create / update / delete / state-transition) worth tracking. " +
      "If you can't answer these confidently, read more before instrumenting.",
  });

  // Loud anti-pattern callout. Agents see "AGENTRY_DSN" and reach for
  // sentry_sdk.init / @sentry/node — but agentry's DSN is `agnt_<uuid>.<token>`,
  // not a Sentry DSN. Sentry's parser raises BadDsn (or fails silently inside a
  // try/except), and the user ends up with `agentry_enabled: false` and no clue.
  // Calling this out as a dedicated step (not just a pitfall at the end) so
  // agents can't skim past it.
  steps.push({
    id: "do_not_use_sentry_sdk",
    title: "Do NOT pass AGENTRY_DSN to sentry_sdk / @sentry/* / any Sentry-compatible client",
    why:
      "agentry's DSN format is `agnt_<projectId>.<token>` — a custom format, NOT a Sentry DSN. " +
      "Sentry's DSN parser requires a URL with an integer project id and will raise BadDsn (Python) " +
      "or silently no-op (JS) when given an agentry DSN. agentry talks plain HTTP to three endpoints; " +
      "there is no SDK to plug into. The /v1/store/ endpoint accepts Sentry-shaped payloads as raw " +
      "POSTs, but you cannot route them through the Sentry SDK's init() / Hub. If you see existing " +
      "`sentry_sdk.init(...)` / `Sentry.init(...)` / `Hub.current` in the codebase, leave it alone " +
      "(or remove it if you're replacing Sentry) — DO NOT feed it AGENTRY_DSN. Use the helper in " +
      "`drop_in_helper` below.",
    action: "manual",
    file_hint:
      "Grep the codebase for `sentry_sdk`, `from sentry`, `@sentry/`, `Sentry.init`, " +
      "`init_observability`, or any wrapper around Sentry. If any exist, note them — you'll " +
      "either leave them untouched or replace them with the agentry helper in the next steps.",
    validate:
      "You can articulate, in one sentence, why agentry is not Sentry-SDK-compatible at the client " +
      "layer. If you find existing Sentry code, you've decided whether to keep it side-by-side or " +
      "replace it; either way, AGENTRY_DSN never goes into a Sentry init call.",
  });

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
      "no agentry-named dependency to vet. The whole helper is ~30 lines. This is THE supported install " +
      "path for this language; there is no `pip install agentry-sdk` / `gem install agentry` / etc. Do not " +
      "substitute sentry_sdk, opentelemetry, or any other third-party client — AGENTRY_DSN is not a Sentry " +
      "DSN and will not validate through those libraries (see the `do_not_use_sentry_sdk` step above).",
    action: "edit",
    file_hint: recipe.helper_file_hint,
    code: recipe.helper_code,
    validate:
      "Function/module is callable from your app. Calling it with a test payload (e.g. " +
      "`agentry.send('analytics', {'event': 'test'})`) returns without raising. If you see BadDsn, " +
      "ImportError on sentry_sdk, or `agentry_enabled: false` from existing observability wrappers, " +
      "you skipped `do_not_use_sentry_sdk` — go back and read it.",
  });

  if (signalTypes.has("logs") || signalTypes.has("analytics") || signalTypes.has("deploys")) {
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

  if (signalTypes.has("logs") || signalTypes.has("analytics")) {
    steps.push(privacyPolicyStep(framework, signalTypes));
  }

  steps.push(...verifySteps());
  steps.push(suggestNextBuildsStep());

  return {
    framework,
    signal_types: [...signalTypes],
    steps,
    pitfalls: [
      "AGENTRY_DSN is NOT a Sentry DSN. Do not pass it to sentry_sdk.init(), @sentry/* clients, or " +
        "any Sentry-compatible library — the format is `agnt_<projectId>.<token>` (UUID project id), " +
        "which Sentry's parser rejects (BadDsn) or silently no-ops. Use the agentry helper above.",
      "If the project already has Sentry wired up (sentry_sdk / @sentry/node / a custom " +
        "observability wrapper), leave that init untouched. agentry runs side-by-side via its own " +
        "helper; the two don't share a DSN or SDK.",
      "ALWAYS set an explicit User-Agent header on direct HTTP calls (e.g. `agentry-python/1.0`, " +
        "`agentry-go/1.0`). Cloudflare's Browser Integrity Check returns 403 (CF error 1010) for " +
        "common default UAs like `Python-urllib/3.x` and `Java/HttpClient`. The helper above " +
        "already sets a custom UA — don't remove that line if you refactor the helper.",
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
