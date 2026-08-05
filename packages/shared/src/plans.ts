/**
 * Plan catalogue.
 *
 * Two deliberate decisions are encoded here, both of which matter more than the
 * numbers:
 *
 * 1. **Limits are on domains and features, not on traffic.** FounderShield sits
 *    in front of a customer's users. Enforcing a request quota would mean
 *    degrading or refusing their traffic to collect our own revenue — trading
 *    their availability for our billing. That is the same trade the proxy
 *    already refuses to make when it fails open. Request volume is metered and
 *    reported so nobody is surprised by an invoice; it is never enforced at the
 *    edge.
 *
 * 2. **Nothing that protects a live site is behind a paywall.** Browser
 *    verification, bot scoring and rate limiting are on every plan including
 *    free. What paid plans add is scale, retention, and the legal-workflow
 *    tooling. A free user whose site is being scraped is still protected.
 */

export type PlanId = 'free' | 'solo' | 'indie' | 'studio' | 'agency';

export type PlanFeature =
  | 'strict-mode'
  | 'auth-gate'
  | 'terms'
  | 'clickwrap'
  | 'evidence-export'
  | 'evidence-seals'
  | 'evidence-report'
  | 'agreements'
  | 'notices'
  | 'priority-support';

export interface Plan {
  id: PlanId;
  name: string;
  /** US dollars per month. */
  monthlyPrice: number;
  tagline: string;
  domains: number;
  /** Monthly request allowance. Advisory — see the note above. */
  includedRequests: number;
  /** How long evidence records are kept. */
  retentionDays: number;
  features: readonly PlanFeature[];
}

/** Every plan gets these. They are what keeps a site standing up. */
export const UNIVERSAL_CAPABILITIES = [
  'Browser verification (proof-of-work + rolling-key tokens)',
  'Automation scoring on every request',
  'Rate limiting',
  'Monitor and standard enforcement modes',
  'Evidence log of blocked and challenged requests',
] as const;

const PAID_BASE: readonly PlanFeature[] = ['strict-mode', 'auth-gate', 'terms', 'clickwrap', 'evidence-export'];

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyPrice: 0,
    tagline: 'Protect one side project properly.',
    domains: 1,
    includedRequests: 25_000,
    retentionDays: 7,
    features: ['evidence-export'],
  },
  solo: {
    id: 'solo',
    name: 'Solo',
    monthlyPrice: 20,
    tagline: 'One product, everything switched on.',
    domains: 1,
    includedRequests: 250_000,
    retentionDays: 30,
    features: PAID_BASE,
  },
  indie: {
    id: 'indie',
    name: 'Indie',
    monthlyPrice: 50,
    tagline: 'A few products, and a record you can hand to a lawyer.',
    domains: 3,
    includedRequests: 1_000_000,
    retentionDays: 90,
    features: [...PAID_BASE, 'evidence-seals', 'evidence-report'],
  },
  studio: {
    id: 'studio',
    name: 'Studio',
    monthlyPrice: 150,
    tagline: 'Contractors, agreements, and the paperwork that follows.',
    domains: 10,
    includedRequests: 5_000_000,
    retentionDays: 365,
    features: [...PAID_BASE, 'evidence-seals', 'evidence-report', 'agreements', 'notices'],
  },
  agency: {
    id: 'agency',
    name: 'Agency',
    monthlyPrice: 300,
    tagline: 'Client work, at volume.',
    domains: 25,
    includedRequests: 25_000_000,
    retentionDays: 1_095,
    features: [...PAID_BASE, 'evidence-seals', 'evidence-report', 'agreements', 'notices', 'priority-support'],
  },
};

export const PLAN_ORDER: readonly PlanId[] = ['free', 'solo', 'indie', 'studio', 'agency'];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && value in PLANS;
}

export function getPlan(id: unknown): Plan {
  return isPlanId(id) ? PLANS[id] : PLANS.free;
}

export function planAllows(planId: unknown, feature: PlanFeature): boolean {
  return getPlan(planId).features.includes(feature);
}

/**
 * The cheapest plan that includes a feature — so the upgrade prompt can name
 * the right one instead of pushing everyone at the most expensive.
 */
export function lowestPlanWith(feature: PlanFeature): Plan | null {
  for (const id of PLAN_ORDER) {
    if (PLANS[id].features.includes(feature)) return PLANS[id];
  }
  return null;
}

export function canAddDomain(planId: unknown, currentDomains: number): boolean {
  return currentDomains < getPlan(planId).domains;
}

/**
 * Subscription states that should still be treated as paid.
 *
 * `past_due` deliberately keeps its plan. A failed card should not silently
 * strip a customer's protection settings — the dashboard shows a warning and
 * Stripe retries. Access ends at `canceled`, not at the first failed payment.
 */
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function effectivePlanId(subscription: { plan_id?: unknown; status?: unknown } | null | undefined): PlanId {
  if (!subscription) return 'free';
  if (!ENTITLED_STATUSES.has(String(subscription.status))) return 'free';
  return isPlanId(subscription.plan_id) ? subscription.plan_id : 'free';
}

export function formatPrice(plan: Plan): string {
  return plan.monthlyPrice === 0 ? 'Free' : `$${plan.monthlyPrice}/mo`;
}

export function formatRequests(count: number): string {
  if (count >= 1_000_000) return `${count / 1_000_000}M`;
  if (count >= 1_000) return `${count / 1_000}k`;
  return String(count);
}

export function formatRetention(days: number): string {
  if (days >= 365) {
    const years = Math.round(days / 365);
    return `${years} year${years === 1 ? '' : 's'}`;
  }
  return `${days} days`;
}

export const FEATURE_LABELS: Readonly<Record<PlanFeature, string>> = {
  'strict-mode': 'Strict mode (withhold pages until verified)',
  'auth-gate': 'Protected routes',
  terms: 'Generated terms of use',
  clickwrap: 'Terms acceptance gate',
  'evidence-export': 'Evidence export (CSV / JSON)',
  'evidence-seals': 'Tamper-evident seals',
  'evidence-report': 'Evidence reports',
  agreements: 'NDA generation and signing',
  notices: 'Notice and demand drafting',
  'priority-support': 'Priority support',
};

/**
 * Usage is *estimated*, and the word is load-bearing.
 *
 * Blocked and challenged requests are always recorded, but ordinary traffic is
 * sampled — that is a deliberate cost decision made in Phase 1. So total volume
 * is reconstructed from the sample rate rather than counted. Presenting that as
 * an exact figure would be a lie told on an invoice, which is why the dashboard
 * labels it an estimate and why limits are advisory.
 */
export function estimateRequests(input: {
  blocked: number;
  challenged: number;
  allowedSampled: number;
  sampleRate: number;
}): { estimate: number; exact: boolean } {
  const enforced = input.blocked + input.challenged;

  // A sample rate of 1 means everything was recorded, so the count is exact.
  if (input.sampleRate >= 1) return { estimate: enforced + input.allowedSampled, exact: true };
  if (input.sampleRate <= 0) return { estimate: enforced, exact: false };

  return { estimate: Math.round(enforced + input.allowedSampled / input.sampleRate), exact: false };
}
