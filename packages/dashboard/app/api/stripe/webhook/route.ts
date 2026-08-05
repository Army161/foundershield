import { NextResponse, type NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { readSubscription, stripeClient } from '@/lib/stripe';

/**
 * Stripe webhook.
 *
 * Three properties this has to hold:
 *
 *   Authenticity — the signature is verified against the raw body before
 *   anything is parsed. An unverified webhook is an unauthenticated request to
 *   change someone's plan.
 *
 *   Idempotency — Stripe retries. Every event id is recorded first, and a
 *   duplicate short-circuits, so a retry cannot apply a change twice.
 *
 *   Failing closed — an unrecognised price maps to the free plan rather than
 *   guessing upward.
 */
export async function POST(request: NextRequest) {
  const stripe = stripeClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !secret) {
    return NextResponse.json({ error: 'billing_not_configured' }, { status: 503 });
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) return NextResponse.json({ error: 'missing_signature' }, { status: 400 });

  // Must be the raw body: any re-serialisation invalidates the signature.
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, secret);
  } catch (error) {
    console.error('stripe signature verification failed', error);
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  const service = createSupabaseServiceClient();

  // Record before acting. A duplicate insert means we have seen this event.
  const { error: ledgerError } = await service
    .from('stripe_events')
    .insert({ id: event.id, type: event.type });

  if (ledgerError) {
    if (ledgerError.code === '23505') {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error('could not record stripe event', ledgerError);
    // Returning non-2xx asks Stripe to retry, which is right: we would rather
    // reprocess than silently drop a plan change.
    return NextResponse.json({ error: 'ledger_unavailable' }, { status: 500 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id ?? session.metadata?.user_id;
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;

        if (!userId) {
          console.error('checkout session had no user reference', session.id);
          break;
        }

        // The session tells us who paid; the subscription tells us for what.
        if (session.subscription) {
          const subscriptionId =
            typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const read = readSubscription(subscription as never);

          await service.from('subscriptions').upsert(
            {
              user_id: userId,
              plan_id: read.planId,
              status: read.status,
              stripe_customer_id: customerId ?? null,
              stripe_subscription_id: subscriptionId,
              stripe_price_id: read.priceId,
              current_period_end: read.currentPeriodEnd,
              cancel_at_period_end: read.cancelAtPeriodEnd,
            },
            { onConflict: 'user_id' },
          );
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;

        const read = readSubscription(subscription as never);

        // A deleted subscription is free regardless of the price it carried.
        const planId = event.type === 'customer.subscription.deleted' ? 'free' : read.planId;
        const status = event.type === 'customer.subscription.deleted' ? 'canceled' : read.status;

        const { error } = await service
          .from('subscriptions')
          .update({
            plan_id: planId,
            status,
            stripe_subscription_id: subscription.id,
            stripe_price_id: read.priceId,
            current_period_end: read.currentPeriodEnd,
            cancel_at_period_end: read.cancelAtPeriodEnd,
          })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('subscription update failed', error);
        break;
      }

      default:
        // Everything else is acknowledged and ignored. Stripe sends a great
        // many event types and reacting to ones we do not understand is how
        // billing states drift.
        break;
    }
  } catch (error) {
    console.error('stripe webhook handler failed', event.type, error);
    // The ledger row stays, so this will not be retried into a double-apply.
    // It is logged loudly instead, because a dropped plan change is a support
    // ticket, not a silent inconsistency.
    return NextResponse.json({ error: 'handler_failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
