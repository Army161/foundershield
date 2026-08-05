-- ===========================================================================
-- Phase 4 — billing
--
-- The subscription row is written only by the Stripe webhook, running as the
-- service role. A customer has no insert or update grant on it at all: the
-- authority on what someone is paying for is Stripe, and a plan a user can
-- write is a plan a user can grant themselves.
--
-- Note what is *not* here: no request quota enforcement, and no column the edge
-- reads. The proxy has no knowledge of billing, by design. It sits in front of
-- customers' users, and cutting their traffic off to collect our revenue would
-- trade their availability for our invoicing.
-- ===========================================================================

do $$ begin
  create type subscription_status as enum (
    'trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users (id) on delete cascade,

  -- Mirrors PlanId in packages/shared/src/plans.ts. Deliberately text rather
  -- than an enum: the catalogue changes with pricing, and a migration to add a
  -- tier should not be a schema migration. `effectivePlanId` treats anything it
  -- does not recognise as free, so an unknown value fails closed.
  plan_id                text not null default 'free',
  status                 subscription_status not null default 'active',

  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  stripe_price_id        text,

  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists subscriptions_customer_idx on public.subscriptions (stripe_customer_id);

drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Webhook idempotency
--
-- Stripe retries, and retries can arrive out of order or more than once. Every
-- processed event id is recorded so a replay is a no-op rather than a second
-- plan change.
-- ---------------------------------------------------------------------------

create table if not exists public.stripe_events (
  id           text primary key,
  type         text not null,
  processed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Usage
--
-- Reconstructed from the evidence log rather than separately metered. Blocked
-- and challenged requests are recorded in full; ordinary traffic is sampled, so
-- the total is an estimate and is labelled one everywhere it is shown. Billing
-- limits are advisory, which is what makes an estimate acceptable here — an
-- estimate driving a hard cutoff would not be.
-- ---------------------------------------------------------------------------

create or replace function public.account_usage(p_user_id uuid, p_since timestamptz)
returns jsonb
language sql
security invoker
stable
as $$
  with owned as (
    select p.id, coalesce((s.logging->>'sampleRate')::numeric, 0.02) as sample_rate
    from public.projects p
    left join public.protection_settings s on s.project_id = p.id
    where p.user_id = p_user_id
  ),
  counted as (
    select
      o.id,
      o.sample_rate,
      count(*) filter (where e.action = 'block')     as blocked,
      count(*) filter (where e.action = 'challenge') as challenged,
      count(*) filter (where e.action = 'allow')     as allowed_sampled
    from owned o
    left join public.request_events e
      on e.project_id = o.id and e.occurred_at >= p_since
    group by o.id, o.sample_rate
  )
  select jsonb_build_object(
    'domains', (select count(*) from owned),
    'blocked', coalesce(sum(blocked), 0),
    'challenged', coalesce(sum(challenged), 0),
    'allowedSampled', coalesce(sum(allowed_sampled), 0),
    -- One rate is not meaningful across projects configured differently, so the
    -- estimate is summed per project and the rate reported only for reference.
    'estimatedRequests', coalesce(sum(
      case
        when sample_rate >= 1 then blocked + challenged + allowed_sampled
        when sample_rate <= 0 then blocked + challenged
        else round(blocked + challenged + allowed_sampled / sample_rate)
      end
    ), 0),
    'exact', coalesce(bool_and(sample_rate >= 1), false),
    'since', p_since
  )
  from counted;
$$;

revoke all on function public.account_usage(uuid, timestamptz) from public, anon;
grant execute on function public.account_usage(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security and grants
-- ---------------------------------------------------------------------------

alter table public.subscriptions enable row level security;
alter table public.stripe_events enable row level security;

drop policy if exists subscriptions_owner_select on public.subscriptions;
create policy subscriptions_owner_select on public.subscriptions
  for select to authenticated using (user_id = auth.uid());

-- No insert, update or delete policy for anyone but the service role. There is
-- deliberately no path by which a customer can change their own plan directly.

revoke all on public.subscriptions from authenticated, anon;
revoke all on public.stripe_events from authenticated, anon;

grant select (
  user_id, plan_id, status, current_period_end, cancel_at_period_end, created_at, updated_at
) on public.subscriptions to authenticated;

-- Stripe identifiers stay server-side: the dashboard never needs them, and the
-- portal session is created with the service role.
grant all on public.subscriptions to service_role;
grant all on public.stripe_events to service_role;
