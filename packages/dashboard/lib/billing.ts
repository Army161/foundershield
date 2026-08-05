'use server';

import { redirect } from 'next/navigation';
import { effectivePlanId, isPlanId, type PlanId } from '@foundershield/shared';
import { createSupabaseServiceClient, requireUser } from './supabase/server';
import { appUrl, priceIdFor, stripeClient } from './stripe';
import type { ActionResult } from './actions';

export interface Subscription {
  user_id: string;
  plan_id: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

/**
 * The account's current plan.
 *
 * Read through the user's own client so RLS applies. A missing row means the
 * account has never subscribed, which is the free plan — not an error.
 */
export async function currentPlanId(): Promise<PlanId> {
  const { supabase, user } = await requireUser();
  if (!user) return 'free';

  const { data } = await supabase
    .from('subscriptions')
    .select('user_id,plan_id,status,current_period_end,cancel_at_period_end')
    .eq('user_id', user.id)
    .maybeSingle();

  return effectivePlanId(data as Subscription | null);
}

export async function currentSubscription(): Promise<Subscription | null> {
  const { supabase, user } = await requireUser();
  if (!user) return null;

  const { data } = await supabase
    .from('subscriptions')
    .select('user_id,plan_id,status,current_period_end,cancel_at_period_end')
    .eq('user_id', user.id)
    .maybeSingle();

  return (data as Subscription | null) ?? null;
}

/**
 * Find or create the Stripe customer for this account.
 *
 * Uses the service role because `stripe_customer_id` has no column grant for
 * the dashboard client — the browser never needs to see it.
 */
async function ensureCustomer(userId: string, email: string): Promise<string> {
  const stripe = stripeClient();
  if (!stripe) throw new Error('Billing is not configured.');

  const service = createSupabaseServiceClient();
  const { data } = await service
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle();

  const existing = (data as { stripe_customer_id: string | null } | null)?.stripe_customer_id;
  if (existing) return existing;

  const customer = await stripe.customers.create({ email, metadata: { user_id: userId } });

  await service
    .from('subscriptions')
    .upsert({ user_id: userId, stripe_customer_id: customer.id }, { onConflict: 'user_id' });

  return customer.id;
}

export async function startCheckout(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const { user } = await requireUser();
  if (!user) redirect('/login');

  const stripe = stripeClient();
  if (!stripe) return { ok: false, error: 'Billing is not configured on this deployment.' };

  const planId = String(formData.get('plan_id') ?? '');
  if (!isPlanId(planId) || planId === 'free') {
    return { ok: false, error: 'Choose a plan to subscribe to.' };
  }

  const priceId = priceIdFor(planId);
  if (!priceId) return { ok: false, error: `No Stripe price is configured for the ${planId} plan.` };

  let url: string | null = null;
  try {
    const customerId = await ensureCustomer(user.id, user.email ?? '');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      metadata: { user_id: user.id, plan_id: planId },
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl()}/dashboard/billing?checkout=success`,
      cancel_url: `${appUrl()}/dashboard/billing?checkout=cancelled`,
      allow_promotion_codes: true,
    });
    url = session.url;
  } catch (error) {
    console.error('checkout session failed', error);
    return { ok: false, error: 'Could not start checkout. Try again in a moment.' };
  }

  if (!url) return { ok: false, error: 'Stripe did not return a checkout URL.' };

  // Outside the try: redirect() throws by design, and catching it would turn a
  // successful checkout into an error message.
  redirect(url);
}

/**
 * Send the customer to Stripe's own portal to change or cancel.
 *
 * Deliberately not reimplemented in-app: card details, proration and dunning
 * are Stripe's job, and every line of that we write ourselves is a line that
 * can get someone's billing wrong.
 */
export async function openBillingPortal(): Promise<void> {
  const { user } = await requireUser();
  if (!user) redirect('/login');

  const stripe = stripeClient();
  if (!stripe) redirect('/dashboard/billing?portal=unavailable');

  const service = createSupabaseServiceClient();
  const { data } = await service
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();

  const customerId = (data as { stripe_customer_id: string | null } | null)?.stripe_customer_id;
  if (!customerId) redirect('/dashboard/billing?portal=no_customer');

  let url: string | null = null;
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl()}/dashboard/billing`,
    });
    url = session.url;
  } catch (error) {
    console.error('billing portal failed', error);
    redirect('/dashboard/billing?portal=error');
  }

  redirect(url ?? '/dashboard/billing');
}
