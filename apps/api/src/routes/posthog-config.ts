// Per-user PostHog feature config: session replay (today), feature flags +
// cohorts + surveys (coming once we expand the master Personal API Key's
// scopes — see decisions.md). All endpoints are api-key authed and scoped
// to the user's PostHog team via getPosthogProjectForUser.

import { Hono } from "hono";
import { errors } from "@agentrysh/shared";
import {
  isPosthogConfigured,
  getTeamSettings,
  updateTeamSettings,
} from "../posthog.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import { audit } from "../audit.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// Session replay — toggle + retention + sampling.
//
// PostHog defaults team.session_recording_opt_in to FALSE. agentry users
// opt in via this endpoint. Per-user; each user decides if they want it on.
//
// The agent's "customized session replay" UX (per docs/decisions.md):
//   - Agent asks the user: "Do you want session replay? Strategies: …"
//   - Agent calls agentry_configure_session_replay with the chosen strategy.
//   - Agent then writes the JS init snippet matching that strategy into the
//     customer's repo (via the install guide's drop_in_helper / wire_errors
//     conversation).
//
// Strategies in v1:
//   - "off":            opt_in=false (default)
//   - "all":            opt_in=true, sample_rate=1.0 — every session
//   - "sampled":        opt_in=true, sample_rate=<f> — random sample
//   - "url_scoped":     opt_in=true, url_trigger_config=[{url}] — only certain pages
//   - "errors_only":    opt_in=true, sample_rate=0 — recording starts only
//                       when posthog.startSessionRecording() is called by
//                       the app (e.g., on captureError). Agent must wire that
//                       call into the customer's error handler.
// ---------------------------------------------------------------------------

router.post(
  "/v1/projects/:project_id/posthog/session-replay/configure",
  requireApiKey(),
  async (c) => {
    if (!isPosthogConfigured(c.env)) {
      throw errors.internal("PostHog not configured on this deployment.");
    }
    const projectId = c.req.param("project_id");
    const proj = await requireProjectAccess(c, projectId);

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      throw errors.invalidPayload({ reason: "body must be JSON" });
    }
    const strategy = String(body.strategy ?? "");
    const sampleRate = typeof body.sample_rate === "number" ? body.sample_rate : undefined;
    const retentionDays = typeof body.retention_days === "number" ? body.retention_days : undefined;
    const urlTriggers = Array.isArray(body.url_triggers)
      ? (body.url_triggers as Array<{ url: string; matching?: string }>)
      : undefined;
    const minDurationMs = typeof body.min_duration_ms === "number" ? body.min_duration_ms : undefined;

    if (!["off", "all", "sampled", "url_scoped", "errors_only"].includes(strategy)) {
      throw errors.invalidPayload({
        reason:
          "strategy must be one of: 'off', 'all', 'sampled', 'url_scoped', 'errors_only'. " +
          "See agentry.md for what each does.",
      });
    }

    // Map strategy → concrete PostHog team settings.
    const patch: Record<string, unknown> = {};
    if (strategy === "off") {
      patch.session_recording_opt_in = false;
    } else {
      patch.session_recording_opt_in = true;
      if (strategy === "all") {
        patch.session_recording_sample_rate = "1.0";
      } else if (strategy === "sampled") {
        const r = sampleRate ?? 0.1;
        if (r <= 0 || r > 1) {
          throw errors.invalidPayload({
            reason: "sample_rate must be in (0, 1] for strategy='sampled' — e.g. 0.1 for 10%.",
          });
        }
        patch.session_recording_sample_rate = String(r);
      } else if (strategy === "url_scoped") {
        if (!urlTriggers || urlTriggers.length === 0) {
          throw errors.invalidPayload({
            reason:
              "strategy='url_scoped' requires url_triggers: [{url, matching}]. " +
              "matching is 'exact' (default) or 'regex'.",
          });
        }
        patch.session_recording_sample_rate = "1.0";
        patch.session_recording_url_trigger_config = urlTriggers.map((t) => ({
          url: t.url,
          matching: t.matching ?? "exact",
        }));
      } else if (strategy === "errors_only") {
        // sample_rate=0 → recording NEVER starts automatically. The app's
        // own posthog.startSessionRecording() (called from captureError /
        // similar) is the trigger. Agent wires this into the helper.
        patch.session_recording_sample_rate = "0";
      }
    }
    if (retentionDays !== undefined) {
      if (retentionDays < 1 || retentionDays > 365) {
        throw errors.invalidPayload({
          reason: "retention_days must be 1–365.",
        });
      }
      // PostHog accepts a few canonical retention strings; the
      // session_recording_retention_period column is varchar(3).
      // Closest canonical mapping.
      const canon =
        retentionDays <= 30 ? "30d" :
        retentionDays <= 90 ? "90d" :
        retentionDays <= 180 ? "1y" : "1y";
      patch.session_recording_retention_period = canon;
    }
    if (minDurationMs !== undefined) {
      patch.session_recording_minimum_duration_milliseconds = Math.max(0, Math.min(60_000, minDurationMs));
    }

    const out = await updateTeamSettings(c.env, proj.userId, patch);
    await audit(c, {
      userId: proj.userId,
      projectId: proj.id,
      action: "session_replay.configured",
      resourceType: "session_replay",
      resourceId: String(out.teamId),
      summary: `Session replay strategy = '${strategy}'`,
      metadata: { strategy, sample_rate: sampleRate, retention_days: retentionDays, url_triggers: urlTriggers?.length ?? 0 },
    });
    return c.json({
      team_id: out.teamId,
      strategy,
      settings: {
        session_recording_opt_in: out.settings.session_recording_opt_in,
        session_recording_sample_rate: out.settings.session_recording_sample_rate,
        session_recording_retention_period: out.settings.session_recording_retention_period,
        session_recording_minimum_duration_milliseconds:
          out.settings.session_recording_minimum_duration_milliseconds,
        session_recording_url_trigger_config: out.settings.session_recording_url_trigger_config,
      },
      next_action:
        strategy === "errors_only"
          ? "Recording is enabled but won't auto-start. Wire `posthog.startSessionRecording()` " +
            "into the customer's error handler (e.g. inside captureError in their agentry " +
            "helper). The 30s of session leading up to each error will be captured."
          : strategy === "url_scoped"
          ? "Recording is enabled and starts when the user lands on one of url_triggers. " +
            "Use PostHog's web UI (Replay tab) to review recordings."
          : strategy === "sampled"
          ? `Recording is enabled at ${patch.session_recording_sample_rate} sample rate. ` +
            "Lower this if storage cost spikes; raise it for more coverage."
          : strategy === "all"
          ? "Recording is enabled for 100% of sessions. Expect significant storage growth — " +
            "consider switching to 'sampled' or 'errors_only' for cost containment."
          : "Recording disabled. No new sessions will be captured.",
    });
  },
);

router.get(
  "/v1/projects/:project_id/posthog/session-replay/status",
  requireApiKey(),
  async (c) => {
    if (!isPosthogConfigured(c.env)) {
      throw errors.internal("PostHog not configured on this deployment.");
    }
    const projectId = c.req.param("project_id");
    const proj = await requireProjectAccess(c, projectId);
    const out = await getTeamSettings(c.env, proj.userId);
    return c.json({
      team_id: out.teamId,
      session_recording_opt_in: out.settings.session_recording_opt_in,
      session_recording_sample_rate: out.settings.session_recording_sample_rate,
      session_recording_retention_period: out.settings.session_recording_retention_period,
      session_recording_minimum_duration_milliseconds:
        out.settings.session_recording_minimum_duration_milliseconds,
      session_recording_url_trigger_config: out.settings.session_recording_url_trigger_config,
      // Generate a deep-link to PostHog's Replay UI for this team. The agent
      // surfaces this when the user asks "show me the replay" — until we
      // wire session_recording:read scope on the master key, this link is
      // the way to view recordings.
      web_ui_url:
        `${(c.env.POSTHOG_HOST ?? "").replace(/\/$/, "")}/project/${out.teamId}/replay/home`,
      next_action: out.settings.session_recording_opt_in
        ? "Session replay is on. To view recordings, open web_ui_url in a browser. " +
          "(Programmatic retrieval via the agentry MCP requires the master PostHog " +
          "Personal API Key to have session_recording:read scope — pending.)"
        : "Session replay is off for this project. To enable, call " +
          "agentry_configure_session_replay with a strategy.",
    });
  },
);

export default router;
