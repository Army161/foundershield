-- ===========================================================================
-- Behaviour tests for 0002 — generated terms defaults and actor_burden().
-- Run after schema_test.sql conventions:
--   npx supabase db reset
--   docker exec -i supabase_db_FOUNDERSHIELD psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/burden_test.sql
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

insert into auth.users (id, email)
values ('55555555-5555-5555-5555-555555555555', 'burden@test.dev');

insert into public.projects (id, user_id, name, domain, origin_url, status)
values ('66666666-6666-6666-6666-666666666666', '55555555-5555-5555-5555-555555555555',
        'Burden', 'burden.example.com', 'https://origin.burden.example.com', 'active');

-- 1. Clickwrap defaults ------------------------------------------------------

do $$
declare v_cw jsonb;
begin
  select clickwrap into v_cw from public.protection_settings
  where project_id = '66666666-6666-6666-6666-666666666666';

  perform test_assert(v_cw ? 'terms', 'clickwrap settings carry a terms slot');
  perform test_assert(v_cw ? 'presentation', 'clickwrap settings carry a presentation mode');
  perform test_assert(v_cw ? 'serveRobotsTxt', 'clickwrap settings carry the robots opt-in');
  perform test_assert(v_cw->>'presentation' = 'interstitial',
    'presentation defaults to interstitial, the mode that actually withholds content');
  perform test_assert((v_cw->>'serveRobotsTxt')::boolean = false,
    'robots.txt is not replaced unless the customer opts in');
  perform test_assert(v_cw->'terms' = 'null'::jsonb, 'no terms are generated until configured');
end $$;

-- 2. Burden aggregation ------------------------------------------------------

-- One heavy scraper: 40 requests inside a single minute, all blocked.
insert into public.request_events
  (project_id, occurred_at, ip, ip_hash, method, host, path, user_agent,
   action, primary_layer, reasons, bot_score, response_status, response_bytes, origin_ms)
select
  '66666666-6666-6666-6666-666666666666',
  timestamptz '2026-08-01 10:00:00Z' + (g * interval '1 second'),
  '203.0.113.10'::inet, 'scraper-hash', 'GET', 'burden.example.com',
  '/api/item/' || g, 'Scrapy/2.11', 'block', 'bots',
  '[{"layer":"bots","ruleId":"ua.scrapy","description":"Request sent by the Scrapy scraping framework","action":"block"}]'::jsonb,
  90, 403, 1000, 25
from generate_series(1, 40) g;

-- One ordinary visitor: 3 requests over ten minutes, all allowed.
insert into public.request_events
  (project_id, occurred_at, ip, ip_hash, method, host, path, user_agent,
   action, reasons, bot_score, response_status, response_bytes, origin_ms)
select
  '66666666-6666-6666-6666-666666666666',
  timestamptz '2026-08-01 10:00:00Z' + (g * interval '5 minutes'),
  '198.51.100.20'::inet, 'human-hash', 'GET', 'burden.example.com',
  '/', 'Mozilla/5.0', 'allow', '[]'::jsonb, 0, 200, 5000, 80
from generate_series(1, 3) g;

do $$
declare v_row record; v_count integer;
begin
  select count(*) into v_count from public.actor_burden(
    '66666666-6666-6666-6666-666666666666', timestamptz '2026-07-01', timestamptz '2026-09-01');
  perform test_assert(v_count = 2, 'burden groups events into one row per address');

  select * into v_row from public.actor_burden(
    '66666666-6666-6666-6666-666666666666', timestamptz '2026-07-01', timestamptz '2026-09-01') limit 1;

  perform test_assert(v_row.ip = '203.0.113.10', 'the heaviest actor is ranked first');
  perform test_assert(v_row.requests = 40, 'request count is totalled');
  perform test_assert(v_row.blocked = 40, 'blocked count is totalled');
  perform test_assert(v_row.allowed = 0, 'allowed count is separated from blocked');
  perform test_assert(v_row.bytes_served = 40000, 'bytes served are totalled');
  perform test_assert(v_row.origin_ms_total = 1000, 'origin time consumed is totalled');
  perform test_assert(v_row.distinct_paths = 40, 'distinct paths are counted');
  perform test_assert(v_row.peak_requests_per_minute = 40,
    'peak per-minute rate is captured, which is the number that shows a burst');
  perform test_assert('Scrapy/2.11' = any(v_row.user_agents), 'user agents are collected');
  perform test_assert('ua.scrapy' = any(v_row.rule_ids), 'the rules that fired are collected');
  perform test_assert(v_row.active_seconds = 39.0, 'the active span is measured');
end $$;

do $$
declare v_row record;
begin
  select * into v_row from public.actor_burden(
    '66666666-6666-6666-6666-666666666666', timestamptz '2026-07-01', timestamptz '2026-09-01')
  where ip = '198.51.100.20';

  perform test_assert(v_row.requests = 3, 'the ordinary visitor is counted separately');
  perform test_assert(v_row.blocked = 0, 'the ordinary visitor was never blocked');
  perform test_assert(v_row.peak_requests_per_minute = 1,
    'a visitor spread over ten minutes shows a peak of one, not three');
end $$;

do $$
declare v_count integer;
begin
  -- A window that excludes everything must return nothing, not everything.
  select count(*) into v_count from public.actor_burden(
    '66666666-6666-6666-6666-666666666666', timestamptz '2026-01-01', timestamptz '2026-01-02');
  perform test_assert(v_count = 0, 'the time window is honoured');
end $$;

-- 3. Report header -----------------------------------------------------------

do $$
declare v_header jsonb;
begin
  select public.evidence_report_header(
    '66666666-6666-6666-6666-666666666666', timestamptz '2026-07-01', timestamptz '2026-09-01')
  into v_header;

  perform test_assert(v_header->'project'->>'domain' = 'burden.example.com', 'header identifies the project');
  perform test_assert((v_header->'totals'->>'events')::int = 43, 'header totals all events in the window');
  perform test_assert((v_header->'totals'->>'blocked')::int = 40, 'header totals blocked events');
  perform test_assert((v_header->'totals'->>'actors')::int = 2, 'header counts distinct actors');
  perform test_assert((v_header->'totals'->>'bytesServed')::bigint = 55000, 'header totals bytes served');
  perform test_assert(v_header->'settingsNow' ? 'clickwrap', 'header records the policy in force');
  perform test_assert(jsonb_typeof(v_header->'seals') = 'array', 'header lists seals');
end $$;

-- 4. Isolation ---------------------------------------------------------------

do $$
declare v_count integer;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
  select count(*) into v_count from public.actor_burden(
    '66666666-6666-6666-6666-666666666666', timestamptz '2026-07-01', timestamptz '2026-09-01');
  perform test_assert(v_count = 2, 'the owner can run burden analysis on their own project');
  reset role;
end $$;

do $$
declare v_count integer;
begin
  insert into auth.users (id, email) values ('77777777-7777-7777-7777-777777777777', 'other@test.dev');

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"77777777-7777-7777-7777-777777777777","role":"authenticated"}';
  select count(*) into v_count from public.actor_burden(
    '66666666-6666-6666-6666-666666666666', timestamptz '2026-07-01', timestamptz '2026-09-01');
  perform test_assert(v_count = 0,
    'another user gets no rows -- burden analysis respects RLS, it does not bypass it');
  reset role;
end $$;

do $$
begin
  set local role anon;
  begin
    perform public.actor_burden('66666666-6666-6666-6666-666666666666',
      timestamptz '2026-07-01', timestamptz '2026-09-01');
    perform test_assert(false, 'anon should not be able to run burden analysis');
  exception when insufficient_privilege then
    perform test_assert(true, 'anon cannot run burden analysis at all');
  end;
  reset role;
end $$;

-- Cleanup --------------------------------------------------------------------

delete from auth.users where email in ('burden@test.dev', 'other@test.dev');
drop function test_assert(boolean, text);

select 'ALL BURDEN TESTS PASSED' as result;
