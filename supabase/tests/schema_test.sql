-- ===========================================================================
-- Schema validation for 0001_init.sql
--
-- Run against a local Supabase stack:
--   npx supabase db reset
--   docker exec -i supabase_db_FOUNDERSHIELD psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/schema_test.sql
--
-- Every check raises on failure, so a non-zero exit means something regressed.
-- These are behaviour tests, not "did the DDL parse" tests: the point is to
-- prove that RLS, the column grants and the evidence chain actually hold.
-- ===========================================================================

\set ON_ERROR_STOP on
\timing off

create or replace function test_assert(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition then
    raise notice 'PASS  %', label;
  else
    raise exception 'FAIL  %', label;
  end if;
end;
$$;

-- Fixtures -------------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.dev'),
  ('22222222-2222-2222-2222-222222222222', 'mallory@test.dev');

insert into public.projects (id, user_id, name, domain, origin_url)
values (
  '33333333-3333-3333-3333-333333333333',
  '11111111-1111-1111-1111-111111111111',
  'Alice App', 'alice.example.com', 'https://origin.alice.example.com'
);

insert into public.projects (user_id, name, domain, origin_url)
values (
  '22222222-2222-2222-2222-222222222222',
  'Mallory App', 'mallory.example.com', 'https://origin.mallory.example.com'
);

-- 1. Provisioning ------------------------------------------------------------

do $$
declare v_count integer;
begin
  select count(*) into v_count from public.protection_settings
  where project_id = '33333333-3333-3333-3333-333333333333';
  perform test_assert(v_count = 1, 'a new project auto-creates its settings row');
end $$;

do $$
declare v_secret text; v_settings public.protection_settings;
begin
  select tpm_secret into v_secret from public.projects
  where id = '33333333-3333-3333-3333-333333333333';

  perform test_assert(v_secret is not null and length(v_secret) >= 42,
    'tpm_secret is generated server-side at 32 bytes');
  perform test_assert(v_secret !~ '[+/]',
    'tpm_secret is url-safe base64 (no + or / that would break the edge decoder)');

  select * into v_settings from public.protection_settings
  where project_id = '33333333-3333-3333-3333-333333333333';

  perform test_assert((v_settings.tpm->>'difficulty')::int = 14, 'default difficulty is 14');
  perform test_assert((v_settings.tpm->>'enabled')::boolean, 'browser verification defaults on');
  perform test_assert(not (v_settings.auth_gate->>'enabled')::boolean, 'auth gate defaults off');
  perform test_assert(v_settings.mode = 'standard', 'default mode is standard');
end $$;

do $$
declare v_token text;
begin
  select verification_token into v_token from public.projects
  where id = '33333333-3333-3333-3333-333333333333';
  perform test_assert(v_token ~ '^[0-9a-f]{32}$', 'verification token is 16 random bytes as hex');
end $$;

-- 2. Constraints -------------------------------------------------------------

do $$
begin
  begin
    insert into public.projects (user_id, name, domain, origin_url)
    values ('11111111-1111-1111-1111-111111111111', 'Bad', 'NOT A DOMAIN', 'https://x.example.com');
    perform test_assert(false, 'malformed domain should be rejected');
  exception when check_violation then
    perform test_assert(true, 'malformed domain is rejected by check constraint');
  end;

  begin
    insert into public.projects (user_id, name, domain, origin_url)
    values ('11111111-1111-1111-1111-111111111111', 'Bad', 'ok.example.com', 'javascript:alert(1)');
    perform test_assert(false, 'non-http origin should be rejected');
  exception when check_violation then
    perform test_assert(true, 'non-http origin is rejected by check constraint');
  end;

  begin
    insert into public.projects (user_id, name, domain, origin_url)
    values ('11111111-1111-1111-1111-111111111111', 'Dup', 'alice.example.com', 'https://x.example.com');
    perform test_assert(false, 'duplicate domain should be rejected');
  exception when unique_violation then
    perform test_assert(true, 'the same domain cannot be claimed twice');
  end;
end $$;

-- 3. edge_config -------------------------------------------------------------

do $$
declare v_config jsonb;
begin
  select public.edge_config('ALICE.EXAMPLE.COM') into v_config;

  perform test_assert(v_config is not null, 'edge_config resolves a domain case-insensitively');
  perform test_assert(v_config->>'projectId' = '33333333-3333-3333-3333-333333333333',
    'edge_config returns the project id');
  perform test_assert(v_config->>'originUrl' = 'https://origin.alice.example.com',
    'edge_config returns the origin');
  perform test_assert(v_config->>'status' = 'pending', 'a new project is not active');
  perform test_assert(length(v_config->>'tpmSecret') > 0, 'edge_config carries the secret to the worker');

  -- These keys are exactly what packages/shared/src/config.ts normalises.
  perform test_assert(v_config ? 'tpm' and v_config ? 'rateLimit' and v_config ? 'bots'
    and v_config ? 'authGate' and v_config ? 'clickwrap' and v_config ? 'logging'
    and v_config ? 'ipAllowlist' and v_config ? 'ipBlocklist',
    'edge_config emits every key EdgeProjectConfig expects');

  perform test_assert(public.edge_config('nobody.example.com') is null,
    'edge_config returns null for an unknown domain');
end $$;

-- 4. Evidence hashing --------------------------------------------------------

insert into public.request_events
  (project_id, occurred_at, ip, ip_hash, method, host, path, user_agent, action, primary_layer, reasons, bot_score, response_status)
select
  '33333333-3333-3333-3333-333333333333',
  now() - (interval '1 minute' * g),
  ('203.0.113.' || g)::inet,
  'hash' || g,
  'GET', 'alice.example.com', '/api/data', 'Scrapy/2.11',
  'block', 'bots',
  '[{"layer":"bots","ruleId":"ua.scrapy","description":"Request sent by the Scrapy scraping framework","action":"block"}]'::jsonb,
  90, 403
from generate_series(1, 5) g;

insert into public.request_events
  (project_id, occurred_at, ip, ip_hash, method, host, path, user_agent, action, response_status)
values
  ('33333333-3333-3333-3333-333333333333', now(), '198.51.100.7'::inet, 'hashok',
   'GET', 'alice.example.com', '/', 'Mozilla/5.0', 'allow', 200);

do $$
declare v_null integer; v_hash text;
begin
  select count(*) into v_null from public.request_events where row_hash is null;
  perform test_assert(v_null = 0, 'every event is hashed on insert by trigger');

  select row_hash into v_hash from public.request_events order by id limit 1;
  perform test_assert(v_hash ~ '^[0-9a-f]{64}$', 'row_hash is a sha-256 hex digest');

  perform test_assert(
    (select count(distinct row_hash) from public.request_events) =
    (select count(*) from public.request_events),
    'distinct events produce distinct hashes');
end $$;

-- 5. Sealing and tamper detection --------------------------------------------

do $$
declare v_seal public.evidence_seals; v_result jsonb;
begin
  select * into v_seal from public.seal_evidence('33333333-3333-3333-3333-333333333333');

  perform test_assert(v_seal.event_count = 6, 'the first seal covers all six events');
  perform test_assert(v_seal.digest ~ '^[0-9a-f]{64}$', 'seal digest is a sha-256 hex digest');
  perform test_assert(v_seal.previous_id is null, 'the first seal has no predecessor');

  select public.verify_evidence_seal(v_seal.id) into v_result;
  perform test_assert((v_result->>'intact')::boolean, 'a freshly created seal verifies as intact');
end $$;

do $$
begin
  begin
    perform public.seal_evidence('33333333-3333-3333-3333-333333333333');
    perform test_assert(false, 'sealing with nothing new should fail');
  exception when others then
    perform test_assert(sqlerrm like '%no unsealed events%', 'sealing twice with no new events is refused');
  end;
end $$;

-- Chain a second seal onto the first.
insert into public.request_events
  (project_id, occurred_at, ip, ip_hash, method, host, path, user_agent, action, response_status)
values
  ('33333333-3333-3333-3333-333333333333', now(), '203.0.113.99'::inet, 'hash99',
   'GET', 'alice.example.com', '/api/data', 'curl/8.4.0', 'block', 403);

do $$
declare v_first public.evidence_seals; v_second public.evidence_seals;
begin
  select * into v_first from public.evidence_seals
  where project_id = '33333333-3333-3333-3333-333333333333' order by to_event limit 1;

  select * into v_second from public.seal_evidence('33333333-3333-3333-3333-333333333333');

  perform test_assert(v_second.event_count = 1, 'the second seal covers only the new event');
  perform test_assert(v_second.previous_id = v_first.id, 'seals chain to their predecessor');
  perform test_assert(v_second.from_event = v_first.to_event + 1, 'seal ranges are contiguous');
end $$;

-- The whole point: an edit made directly in the database, by someone who has
-- bypassed every grant, still breaks the seal.
do $$
declare v_seal public.evidence_seals; v_result jsonb;
begin
  select * into v_seal from public.evidence_seals
  where project_id = '33333333-3333-3333-3333-333333333333' order by to_event limit 1;

  update public.request_events
  set user_agent = 'Mozilla/5.0 (totally a real browser)'
  where id = v_seal.from_event;

  select public.verify_evidence_seal(v_seal.id) into v_result;
  perform test_assert(not (v_result->>'intact')::boolean,
    'editing a sealed event as superuser is detected by the seal');
  perform test_assert((v_result->>'alteredRows')::int = 1,
    'the seal localises the edit to a single row');

  -- Put it back so later assertions see the original data.
  update public.request_events set user_agent = 'Scrapy/2.11' where id = v_seal.from_event;

  select public.verify_evidence_seal(v_seal.id) into v_result;
  perform test_assert((v_result->>'intact')::boolean, 'restoring the exact value restores the digest');
end $$;

-- The sophisticated version of the same attack: edit the row *and* recompute
-- its stored hash so the row is self-consistent. The chain digest still moves.
do $$
declare v_seal public.evidence_seals; v_result jsonb; v_target bigint;
begin
  select * into v_seal from public.evidence_seals
  where project_id = '33333333-3333-3333-3333-333333333333' order by to_event limit 1;
  v_target := v_seal.from_event;

  update public.request_events set user_agent = 'Mozilla/5.0 (fabricated)' where id = v_target;
  update public.request_events e set row_hash = public.event_row_hash(e) where e.id = v_target;

  select public.verify_evidence_seal(v_seal.id) into v_result;
  perform test_assert((v_result->>'alteredRows')::int = 0,
    'the doctored row is internally self-consistent, as the attacker intended');
  perform test_assert(not (v_result->>'intact')::boolean,
    'recomputing the stored hash after an edit still breaks the sealed chain');

  update public.request_events set user_agent = 'Scrapy/2.11' where id = v_target;
  update public.request_events e set row_hash = public.event_row_hash(e) where e.id = v_target;

  select public.verify_evidence_seal(v_seal.id) into v_result;
  perform test_assert((v_result->>'intact')::boolean, 'and reverting it restores the chain');
end $$;

do $$
declare v_seal public.evidence_seals; v_result jsonb;
begin
  select * into v_seal from public.evidence_seals
  where project_id = '33333333-3333-3333-3333-333333333333' order by to_event limit 1;

  delete from public.request_events where id = v_seal.to_event;

  select public.verify_evidence_seal(v_seal.id) into v_result;
  perform test_assert(not (v_result->>'intact')::boolean, 'deleting a sealed event is detected');
  perform test_assert((v_result->>'actualCount')::int < (v_result->>'expectedCount')::int,
    'the seal reports how many events went missing');
end $$;

-- 6. Statistics --------------------------------------------------------------

do $$
declare v_stats jsonb;
begin
  select public.project_event_stats('33333333-3333-3333-3333-333333333333', now() - interval '1 day')
  into v_stats;

  perform test_assert((v_stats->>'total')::int > 0, 'stats count events');
  perform test_assert((v_stats->>'blocked')::int > 0, 'stats count blocked events');
  perform test_assert(jsonb_array_length(v_stats->'topIps') > 0, 'stats list the most-stopped addresses');
  perform test_assert(v_stats->'byLayer' ? 'bots', 'stats break down by layer');
end $$;

-- 7. Row level security ------------------------------------------------------

do $$
declare v_visible integer;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

  select count(*) into v_visible from public.projects;
  perform test_assert(v_visible = 1, 'a signed-in user sees only their own projects');

  select count(*) into v_visible from public.projects where domain = 'mallory.example.com';
  perform test_assert(v_visible = 0, 'another user''s project is invisible, not merely unlisted');

  select count(*) into v_visible from public.request_events;
  perform test_assert(v_visible > 0, 'a user can read their own evidence');

  reset role;
end $$;

do $$
declare v_visible integer;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

  select count(*) into v_visible from public.request_events;
  perform test_assert(v_visible = 0, 'a user cannot read another user''s evidence');

  reset role;
end $$;

-- An anonymous caller must not be able to read any of this. It now fails at the
-- grant, before RLS is even consulted, so accept either outcome — both mean
-- "cannot read", and failing earlier is the stronger of the two.
do $$
declare v_visible integer;
begin
  set local role anon;
  begin
    select count(*) into v_visible from public.projects;
    perform test_assert(v_visible = 0, 'an anonymous caller sees no projects');
  exception when insufficient_privilege then
    perform test_assert(true, 'an anonymous caller is refused at the grant, before RLS');
  end;
  reset role;
end $$;

do $$
declare v_visible integer;
begin
  set local role anon;
  begin
    select count(*) into v_visible from public.request_events;
    perform test_assert(v_visible = 0, 'an anonymous caller sees no evidence');
  exception when insufficient_privilege then
    perform test_assert(true, 'an anonymous caller cannot reach the evidence table at all');
  end;
  reset role;
end $$;

-- 8. Column and table grants -------------------------------------------------

do $$
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

  begin
    perform tpm_secret from public.projects where id = '33333333-3333-3333-3333-333333333333';
    perform test_assert(false, 'reading tpm_secret as the owner should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'the project secret is unreadable even by the project owner');
  end;

  begin
    update public.projects set status = 'active' where id = '33333333-3333-3333-3333-333333333333';
    perform test_assert(false, 'self-activating a project should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'a customer cannot mark their own domain active');
  end;

  begin
    update public.projects set dns_verified_at = now() where id = '33333333-3333-3333-3333-333333333333';
    perform test_assert(false, 'self-verifying a domain should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'a customer cannot assert their own DNS verification');
  end;

  -- ...but the fields they legitimately own still work.
  update public.projects set name = 'Renamed' where id = '33333333-3333-3333-3333-333333333333';
  perform test_assert(true, 'the owner can still rename their own project');

  begin
    insert into public.request_events
      (project_id, occurred_at, ip_hash, method, host, path, action, response_status)
    values ('33333333-3333-3333-3333-333333333333', now(), 'x', 'GET', 'a', '/', 'allow', 200);
    perform test_assert(false, 'writing evidence as a user should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'evidence cannot be fabricated by the account it would benefit');
  end;

  begin
    update public.request_events set action = 'allow'
    where project_id = '33333333-3333-3333-3333-333333333333';
    perform test_assert(false, 'editing evidence should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'recorded evidence cannot be edited');
  end;

  begin
    delete from public.request_events
    where project_id = '33333333-3333-3333-3333-333333333333';
    perform test_assert(false, 'deleting evidence should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'recorded evidence cannot be deleted');
  end;

  begin
    perform public.edge_config('alice.example.com');
    perform test_assert(false, 'calling edge_config as a user should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'edge_config is reachable only by the service role');
  end;

  reset role;
end $$;

-- The settings a customer legitimately controls must still be writable.
do $$
declare v_difficulty integer;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

  update public.protection_settings
  set tpm = jsonb_set(tpm, '{difficulty}', '18'::jsonb), mode = 'strict'
  where project_id = '33333333-3333-3333-3333-333333333333';

  select (tpm->>'difficulty')::int into v_difficulty from public.protection_settings
  where project_id = '33333333-3333-3333-3333-333333333333';
  perform test_assert(v_difficulty = 18, 'the owner can change their own protection settings');

  reset role;
end $$;

-- 9. Cascades ----------------------------------------------------------------

do $$
declare v_events integer; v_settings integer; v_seals integer;
begin
  delete from public.projects where id = '33333333-3333-3333-3333-333333333333';

  select count(*) into v_events from public.request_events
  where project_id = '33333333-3333-3333-3333-333333333333';
  select count(*) into v_settings from public.protection_settings
  where project_id = '33333333-3333-3333-3333-333333333333';
  select count(*) into v_seals from public.evidence_seals
  where project_id = '33333333-3333-3333-3333-333333333333';

  perform test_assert(v_events = 0 and v_settings = 0 and v_seals = 0,
    'deleting a project removes its settings, evidence and seals');
end $$;

do $$
declare v_projects integer;
begin
  delete from auth.users where id = '22222222-2222-2222-2222-222222222222';
  select count(*) into v_projects from public.projects
  where user_id = '22222222-2222-2222-2222-222222222222';
  perform test_assert(v_projects = 0, 'deleting an account removes its projects');
end $$;

-- Cleanup --------------------------------------------------------------------

delete from auth.users where email in ('alice@test.dev', 'mallory@test.dev');
drop function test_assert(boolean, text);

select 'ALL SCHEMA TESTS PASSED' as result;
