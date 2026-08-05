import { redirect } from 'next/navigation';
import {
  FEATURE_LABELS,
  PLANS,
  PLAN_ORDER,
  UNIVERSAL_CAPABILITIES,
  formatPrice,
  formatRequests,
  formatRetention,
  getPlan,
} from '@foundershield/shared';
import { requireUser } from '@/lib/supabase/server';
import { currentPlanId, currentSubscription, openBillingPortal, startCheckout } from '@/lib/billing';
import { billingEnabled, purchasablePlans } from '@/lib/stripe';
import { ActionForm, SubmitButton } from '@/components/form';

interface Usage {
  domains: number;
  blocked: number;
  challenged: number;
  allowedSampled: number;
  estimatedRequests: number;
  exact: boolean;
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; portal?: string }>;
}) {
  const { checkout, portal } = await searchParams;
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const [planId, subscription] = await Promise.all([currentPlanId(), currentSubscription()]);
  const plan = getPlan(planId);

  const since = new Date();
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const { data: usageData } = await supabase.rpc('account_usage', {
    p_user_id: user.id,
    p_since: since.toISOString(),
  });
  const usage = (usageData ?? null) as Usage | null;

  const purchasable = purchasablePlans();
  const overDomainLimit = (usage?.domains ?? 0) > plan.domains;
  const overRequests = (usage?.estimatedRequests ?? 0) > plan.includedRequests;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Billing</h1>
        <p className="hint">You are on the {plan.name} plan.</p>
      </div>

      {checkout === 'success' && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Payment received. If your plan still looks wrong, give it a few seconds — Stripe confirms it by webhook.
        </p>
      )}
      {checkout === 'cancelled' && (
        <p className="rounded-lg bg-surface px-3 py-2 text-sm text-ink-soft">
          Checkout cancelled. Nothing was charged.
        </p>
      )}
      {portal && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {portal === 'no_customer'
            ? 'There is no billing account to manage yet — subscribe to a plan first.'
            : 'The billing portal is unavailable right now.'}
        </p>
      )}

      {subscription?.status === 'past_due' && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>A payment did not go through.</strong> Your protection is still running and your settings are
          untouched — we do not switch off a live site over a card problem. Update your card to avoid the subscription
          being cancelled.
        </p>
      )}

      {subscription?.cancel_at_period_end && subscription.current_period_end && (
        <p className="rounded-lg bg-surface px-3 py-2 text-sm text-ink-soft">
          Your subscription ends on {new Date(subscription.current_period_end).toLocaleDateString()}. Until then nothing
          changes.
        </p>
      )}

      <section className="card">
        <h2 className="text-base font-semibold">This month</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-sm text-ink-faint">Domains</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${overDomainLimit ? 'text-red-700' : ''}`}>
              {usage?.domains ?? 0}
              <span className="text-base font-normal text-ink-faint"> / {plan.domains}</span>
            </p>
          </div>
          <div>
            <p className="text-sm text-ink-faint">Requests {usage?.exact ? '' : '(estimated)'}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${overRequests ? 'text-amber-700' : ''}`}>
              {(usage?.estimatedRequests ?? 0).toLocaleString()}
              <span className="text-base font-normal text-ink-faint">
                {' '}
                / {formatRequests(plan.includedRequests)}
              </span>
            </p>
          </div>
          <div>
            <p className="text-sm text-ink-faint">Blocked</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{(usage?.blocked ?? 0).toLocaleString()}</p>
          </div>
        </div>

        {!usage?.exact && (
          <p className="mt-3 text-xs text-ink-faint">
            Blocked and challenged requests are counted in full. Ordinary traffic is sampled, so total volume is
            reconstructed from the sample rate rather than counted — which is why it says estimated.
          </p>
        )}

        {overRequests && (
          <p className="mt-3 rounded-lg bg-surface px-3 py-2 text-sm text-ink-soft">
            You are over the request allowance for this plan. <strong>Nothing has been throttled or blocked.</strong>{' '}
            FounderShield sits in front of your users, and we will not degrade your site to collect a bill. Get in touch
            and we will sort out the right plan.
          </p>
        )}

        {overDomainLimit && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900">
            You have more domains than this plan allows. Existing domains keep working — you cannot add new ones until
            you upgrade or remove one.
          </p>
        )}
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">On every plan, including free</h2>
        <ul className="mt-3 grid gap-1.5 text-sm text-ink-soft sm:grid-cols-2">
          {UNIVERSAL_CAPABILITIES.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-faint">
          Nothing that keeps a live site standing up is behind a paywall. Paid plans add scale, retention and the legal
          workflow tooling.
        </p>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {PLAN_ORDER.map((id) => {
          const candidate = PLANS[id];
          const isCurrent = id === planId;
          const canBuy = purchasable.includes(id);

          return (
            <div
              key={id}
              className={`card flex flex-col ${isCurrent ? 'border-ink ring-1 ring-ink' : ''}`}
            >
              <div className="flex items-baseline justify-between">
                <h3 className="text-base font-semibold">{candidate.name}</h3>
                <span className="text-lg font-semibold tabular-nums">{formatPrice(candidate)}</span>
              </div>
              <p className="hint">{candidate.tagline}</p>

              <ul className="mt-4 flex-1 space-y-1.5 text-sm text-ink-soft">
                <li>
                  {candidate.domains} domain{candidate.domains === 1 ? '' : 's'}
                </li>
                <li>{formatRequests(candidate.includedRequests)} requests/month</li>
                <li>{formatRetention(candidate.retentionDays)} evidence retention</li>
                {candidate.features.map((feature) => (
                  <li key={feature}>{FEATURE_LABELS[feature]}</li>
                ))}
              </ul>

              <div className="mt-5">
                {isCurrent ? (
                  <p className="text-sm font-medium text-ink-faint">Current plan</p>
                ) : id === 'free' ? (
                  <p className="text-sm text-ink-faint">Downgrade via the billing portal.</p>
                ) : canBuy ? (
                  <ActionForm action={startCheckout}>
                    <input type="hidden" name="plan_id" value={id} />
                    <SubmitButton className="btn w-full" pendingLabel="Opening…">
                      Choose {candidate.name}
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  <p className="text-sm text-ink-faint">
                    {billingEnabled() ? 'No price configured yet.' : 'Billing is not configured.'}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </section>

      {billingEnabled() && subscription !== null ? (
        <section className="card">
          <h2 className="text-base font-semibold">Manage subscription</h2>
          <p className="hint">
            Cards, invoices, plan changes and cancellation are handled by Stripe directly — we do not hold your card
            details.
          </p>
          <form action={openBillingPortal} className="mt-4">
            <button type="submit" className="btn-secondary">
              Open billing portal
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
