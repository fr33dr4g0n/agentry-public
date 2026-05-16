// Plan definitions — single source of truth for tier names, limits, and prices.
// No enforcement is wired up yet; the meter just observes. Flipping enforcement
// on later means consulting `monthlyEvents` at ingest time.

export type PlanId = "free" | "pro" | "scale";

export interface PlanLimits {
  id: PlanId;
  name: string;
  // Monthly ingest cap aggregated across all signal types (errors + analytics + deploys)
  // and all of a user's projects.
  monthlyEvents: number;
  // Retention window for events/cases/deploys/analytics. Drives the future
  // retention sweep job; informational only for now.
  retentionDays: number;
  // Monthly price in USD cents (annual = 2 months free, applied at billing time).
  priceCents: number;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free",
    name: "Free",
    monthlyEvents: 100_000,
    retentionDays: 180,  // 6 months
    priceCents: 0,
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyEvents: 1_000_000,
    retentionDays: 365,  // 12 months
    priceCents: 3_900,   // $39/mo
  },
  scale: {
    id: "scale",
    name: "Scale",
    monthlyEvents: 10_000_000,
    retentionDays: 730,  // 24 months
    priceCents: 14_900,  // $149/mo
  },
};

export const DEFAULT_PLAN: PlanId = "free";

export function planFor(planId: string | null | undefined): PlanLimits {
  if (planId === "pro") return PLANS.pro;
  if (planId === "scale") return PLANS.scale;
  return PLANS.free;
}

export function isValidPlanId(s: string): s is PlanId {
  return s === "free" || s === "pro" || s === "scale";
}
