import Stripe from 'stripe';
import { PLAN_ORDER, isPlanId, type PlanId } from '@foundershield/shared';

/**
 * Stripe is optional.
 *
 * Without keys the dashboard runs perfectly well on the free plan — local
 * development, self-hosting, and the test suite all work with no Stripe account
 * at all. Billing is a way to charge for the product, not a dependency of it.
 */
export function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  // Pinned rather than left to default, so a Stripe SDK upgrade cannot silently
  // change the shape of webhook payloads underneath the handler.
  return new Stripe(key, { apiVersion: '2025-02-24.acacia' });
}

export function billingEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Plan to Stripe price, from the environment.
 *
 * Prices live in Stripe, not in code: a price id is per-account and differs
 * between test and live mode, so hardcoding one guarantees a broken checkout in
 * some environment. `plans.ts` owns what a plan *is*; Stripe owns what it costs.
 */
export function priceIdFor(planId: PlanId): string | null {
  const key = `STRIPE_PRICE_${planId.toUpperCase()}`;
  return process.env[key] ?? null;
}

/** Reverse lookup, for turning a webhook payload back into a plan. */
export function planIdForPrice(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  for (const planId of PLAN_ORDER) {
    if (priceIdFor(planId) === priceId) return planId;
  }
  return null;
}

/**
 * Plans a customer can actually check out. A plan with no configured price is
 * hidden rather than offered and then failing at the Stripe call.
 */
export function purchasablePlans(): PlanId[] {
  if (!billingEnabled()) return [];
  return PLAN_ORDER.filter((id) => id !== 'free' && priceIdFor(id) !== null);
}

export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
}

/**
 * Extract the plan and status from a subscription object.
 *
 * Kept separate from the webhook handler so it can be tested without a Stripe
 * account: everything interesting about interpreting a webhook happens here.
 */
export function readSubscription(subscription: {
  status: string;
  items?: { data?: Array<{ price?: { id?: string } }> };
  current_period_end?: number;
  cancel_at_period_end?: boolean;
}): {
  planId: PlanId;
  status: string;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
} {
  const priceId = subscription.items?.data?.[0]?.price?.id ?? null;
  const mapped = planIdForPrice(priceId);

  return {
    // An unrecognised price means we cannot say what was bought. Falling back
    // to free is the safe direction: it under-grants rather than over-grants,
    // and shows up immediately rather than silently handing out an upgrade.
    planId: mapped && isPlanId(mapped) ? mapped : 'free',
    status: subscription.status,
    priceId,
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
  };
}
