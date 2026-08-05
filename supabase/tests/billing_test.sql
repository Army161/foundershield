-- ===========================================================================
-- Behaviour tests for 0004 — billing.
--   docker exec -i supabase_db_FOUNDERSHIELD psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/billing_test.sql
-- ===========================================================================

\set ON_ERROR_STOP on

create or replace function test_assert(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition then raise notice 'PASS  %', label;
  else raise exception 'FAIL  %', label;
  end if;
end;
$$;

insert into auth.users (id, email) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'payer@test.dev'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'freeloader@test.dev');

insert into public.projects (id, user_id, name, domain, origin_url, status)
values ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
        'Payer App', 'payer.example.com', 'https://origin.payer.example.com', 'active');

-- 1. Defaults ----------------------------------------------------------------

do $$
declare v_row public.subscriptions;
begin
  insert into public.subscriptions (user_id) values ('dddddddd-dddd-dddd-dddd-dddddddddddd');
  select * into v_row from public.subscriptions where user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  perform test_assert(v_row.plan_id = 'free', 'a new subscription row defaults to the free plan');
  perform test_assert(v_row.status = 'active', 'and to an active status');
  perform test_assert(v_row.cancel_at_period_end = false, 'and is not pending cancellation');
end $$;

do $$
begin
  update public.subscriptions
  set plan_id = 'studio', status = 'active', stripe_customer_id = 'cus_test123',
      stripe_subscription_id = 'sub_test123', current_period_end = now() + interval '30 days'
  where user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  perform test_assert(true, 'the service role can record a plan change');
end $$;

do $$
begin
  begin
    insert into public.subscriptions (user_id, stripe_customer_id)
    values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cus_test123');
    perform test_assert(false, 'reusing a Stripe customer id should fail');
  exception when unique_violation then
    perform test_assert(true, 'a Stripe customer cannot be attached to two accounts');
  end;
end $$;

-- 2. Idempotency -------------------------------------------------------------

do $$
begin
  insert into public.stripe_events (id, type) values ('evt_1', 'customer.subscription.updated');
  begin
    insert into public.stripe_events (id, type) values ('evt_1', 'customer.subscription.updated');
    perform test_assert(false, 'processing the same event twice should fail');
  exception when unique_violation then
    perform test_assert(true, 'a replayed Stripe event is rejected, so a retry cannot double-apply');
  end;
end $$;

-- 3. Usage estimation --------------------------------------------------------

update public.protection_settings
set logging = jsonb_build_object('sampleRate', 0.02, 'logAllowed', true)
where project_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

insert into public.request_events
  (project_id, occurred_at, ip, ip_hash, method, host, path, user_agent, action, response_status)
select 'ffffffff-ffff-ffff-ffff-ffffffffffff', now(), '203.0.113.1'::inet, 'h', 'GET',
       'payer.example.com', '/', 'Scrapy/2.11', 'block', 403
from generate_series(1, 100);

insert into public.request_events
  (project_id, occurred_at, ip, ip_hash, method, host, path, user_agent, action, response_status)
select 'ffffffff-ffff-ffff-ffff-ffffffffffff', now(), '198.51.100.1'::inet, 'h2', 'GET',
       'payer.example.com', '/', 'Mozilla/5.0', 'allow', 200
from generate_series(1, 20);

do $$
declare v_usage jsonb;
begin
  select public.account_usage('dddddddd-dddd-dddd-dddd-dddddddddddd', now() - interval '1 day') into v_usage;

  perform test_assert((v_usage->>'domains')::int = 1, 'usage counts the account’s domains');
  perform test_assert((v_usage->>'blocked')::int = 100, 'blocked requests are counted in full');
  perform test_assert((v_usage->>'allowedSampled')::int = 20, 'sampled allowed requests are counted as recorded');
  -- 100 blocked + 20/0.02 = 1100
  perform test_assert((v_usage->>'estimatedRequests')::bigint = 1100,
    'the estimate scales sampled traffic back up by the sample rate');
  perform test_assert((v_usage->>'exact')::boolean = false,
    'and is reported as an estimate, not an exact count');
end $$;

do $$
declare v_usage jsonb;
begin
  update public.protection_settings
  set logging = jsonb_build_object('sampleRate', 1, 'logAllowed', true)
  where project_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  select public.account_usage('dddddddd-dddd-dddd-dddd-dddddddddddd', now() - interval '1 day') into v_usage;
  perform test_assert((v_usage->>'exact')::boolean = true,
    'with nothing sampled away, the count is reported as exact');
  perform test_assert((v_usage->>'estimatedRequests')::bigint = 120, 'and equals what was actually recorded');
end $$;

do $$
declare v_usage jsonb;
begin
  select public.account_usage('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', now() - interval '1 day') into v_usage;
  perform test_assert((v_usage->>'domains')::int = 0, 'an account with no projects reports no domains');
  perform test_assert((v_usage->>'estimatedRequests')::bigint = 0, 'and no requests');
end $$;

-- 4. Authority ---------------------------------------------------------------

do $$
declare v_plan text;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';

  select plan_id into v_plan from public.subscriptions;
  perform test_assert(v_plan = 'studio', 'a customer can read their own plan');

  begin
    update public.subscriptions set plan_id = 'agency'
    where user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    perform test_assert(false, 'self-upgrading should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'a customer cannot grant themselves a plan');
  end;

  begin
    insert into public.subscriptions (user_id, plan_id)
    values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'agency');
    perform test_assert(false, 'inserting a subscription should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'a customer cannot create their own subscription row');
  end;

  begin
    perform stripe_customer_id from public.subscriptions limit 1;
    perform test_assert(false, 'reading Stripe identifiers should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'Stripe identifiers are not readable by the dashboard client');
  end;

  reset role;
end $$;

do $$
declare v_count integer;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated"}';
  select count(*) into v_count from public.subscriptions;
  perform test_assert(v_count = 0, 'a customer cannot see anyone else’s subscription');
  reset role;
end $$;

do $$
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';
  begin
    perform * from public.stripe_events limit 1;
    perform test_assert(false, 'reading the webhook ledger should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'the Stripe event ledger is not readable by customers');
  end;
  reset role;
end $$;

do $$
begin
  set local role anon;
  begin
    perform * from public.subscriptions limit 1;
    perform test_assert(false, 'anon should not reach subscriptions');
  exception when insufficient_privilege then
    perform test_assert(true, 'anon cannot reach subscriptions at all');
  end;
  reset role;
end $$;

-- 5. Cascade -----------------------------------------------------------------

do $$
declare v_count integer;
begin
  delete from auth.users where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  select count(*) into v_count from public.subscriptions
  where user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  perform test_assert(v_count = 0, 'deleting an account removes its subscription');
end $$;

delete from auth.users where email in ('payer@test.dev', 'freeloader@test.dev');
drop function test_assert(boolean, text);

select 'ALL BILLING TESTS PASSED' as result;
