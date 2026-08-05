-- ===========================================================================
-- Behaviour tests for 0003 — agreements, signatures and notices.
--   docker exec -i supabase_db_FOUNDERSHIELD psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/agreements_test.sql
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
  ('88888888-8888-8888-8888-888888888888', 'owner@test.dev'),
  ('99999999-9999-9999-9999-999999999999', 'stranger@test.dev');

insert into public.projects (id, user_id, name, domain, origin_url, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '88888888-8888-8888-8888-888888888888',
        'Owner App', 'owner.example.com', 'https://origin.owner.example.com', 'active');

insert into public.agreements (id, user_id, name, version, input, body)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '88888888-8888-8888-8888-888888888888',
        'Contractor NDA', 'v1hash000001', '{"termYears":3}'::jsonb,
        'NON-DISCLOSURE AGREEMENT ... original text');

-- 1. Signing flow ------------------------------------------------------------

insert into public.agreement_signatures (id, agreement_id, signer_name, signer_email, signed_version)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'Sam Contractor', 'sam@example.dev', 'v1hash000001');

do $$
declare v_token text; v_view jsonb; v_sign jsonb; v_row public.agreement_signatures;
begin
  select access_token into v_token from public.agreement_signatures
  where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  perform test_assert(v_token ~ '^[0-9a-f]{48}$', 'a signing token is 24 random bytes');

  select public.signature_view(v_token) into v_view;
  perform test_assert(v_view->>'status' = 'viewed', 'opening the link records that it was viewed');
  perform test_assert(v_view->>'body' like 'NON-DISCLOSURE%', 'the signer is shown the agreement text');

  select public.signature_sign(v_token, '  Sam Contractor  ', '203.0.113.55', 'Mozilla/5.0') into v_sign;
  perform test_assert((v_sign->>'ok')::boolean, 'signing succeeds');

  select * into v_row from public.agreement_signatures where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  perform test_assert(v_row.status = 'signed', 'status becomes signed');
  perform test_assert(v_row.typed_name = 'Sam Contractor', 'the typed name is trimmed and stored');
  perform test_assert(v_row.signature_ip = '203.0.113.55'::inet, 'the signing address is recorded');
  perform test_assert(v_row.signature_ua = 'Mozilla/5.0', 'the signing client is recorded');
  perform test_assert(v_row.signed_at is not null, 'the signing time is recorded');
  perform test_assert(
    v_row.body_hash = encode(sha256(convert_to('NON-DISCLOSURE AGREEMENT ... original text', 'UTF8')), 'hex'),
    'the hash recorded is of the exact text that was signed');
end $$;

do $$
declare v_token text;
begin
  select access_token into v_token from public.agreement_signatures
  where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  begin
    perform public.signature_sign(v_token, 'Someone Else', '203.0.113.99', 'curl/8');
    perform test_assert(false, 'signing twice should fail');
  exception when others then
    perform test_assert(sqlerrm like '%already signed%', 'a link cannot be used to sign twice');
  end;
end $$;

do $$
begin
  begin
    perform public.signature_sign('deadbeef', 'Nobody', '', '');
    perform test_assert(false, 'an unknown token should fail');
  exception when others then
    perform test_assert(sqlerrm like '%unknown signing link%', 'an unknown token signs nothing');
  end;
end $$;

do $$
declare v_token text;
begin
  insert into public.agreement_signatures (agreement_id, signer_name, signer_email, signed_version)
  values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Blank Name', 'blank@example.dev', 'v1hash000001')
  returning access_token into v_token;

  begin
    perform public.signature_sign(v_token, '   ', '', '');
    perform test_assert(false, 'signing with a blank name should fail');
  exception when others then
    perform test_assert(sqlerrm like '%name is required%', 'a signature requires a name');
  end;
end $$;

-- 2. Immutability ------------------------------------------------------------

do $$
begin
  begin
    update public.agreement_signatures set status = 'pending'
    where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    perform test_assert(false, 'reopening a signed signature should fail');
  exception when others then
    perform test_assert(sqlerrm like '%cannot be changed%', 'a signed signature cannot be reopened');
  end;

  begin
    update public.agreement_signatures set typed_name = 'Someone Else'
    where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    perform test_assert(false, 'rewriting a signed record should fail');
  exception when others then
    perform test_assert(sqlerrm like '%immutable%', 'the record of a completed signature cannot be rewritten');
  end;

  begin
    update public.agreements set body = 'SUBSTITUTED TEXT'
    where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    perform test_assert(false, 'editing a signed agreement should fail');
  exception when others then
    perform test_assert(sqlerrm like '%can no longer be edited%',
      'an agreement that has been signed cannot be edited underneath the signature');
  end;

  -- Renaming is still allowed: it does not change what was signed.
  update public.agreements set name = 'Contractor NDA (2026)'
  where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  perform test_assert(true, 'an agreement can still be renamed after signature');
end $$;

do $$
declare v_id uuid;
begin
  -- An unsigned agreement is freely editable.
  insert into public.agreements (user_id, name, version, input, body)
  values ('88888888-8888-8888-8888-888888888888', 'Draft', 'v2hash000002', '{}'::jsonb, 'draft text')
  returning id into v_id;

  update public.agreements set body = 'revised text', version = 'v2hash000003' where id = v_id;
  perform test_assert(true, 'an unsigned agreement can still be revised');
end $$;

-- 3. Notices -----------------------------------------------------------------

do $$
declare v_id uuid; v_row public.notices;
begin
  insert into public.notices (project_id, kind, addressee, subject, body, cautions)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'circumvention', 'Example Hosting',
          'Automated access', 'body text', '["have a lawyer read this"]'::jsonb)
  returning id into v_id;

  select * into v_row from public.notices where id = v_id;
  perform test_assert(v_row.marked_sent_at is null, 'a drafted notice is not marked as sent');
  perform test_assert(jsonb_array_length(v_row.cautions) = 1, 'the cautions are kept with the draft');

  update public.notices set marked_sent_at = now() where id = v_id;
  perform test_assert(true, 'the operator can record that they sent it themselves');
end $$;

-- 4. Isolation ---------------------------------------------------------------

do $$
declare v_count integer;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"88888888-8888-8888-8888-888888888888","role":"authenticated"}';
  select count(*) into v_count from public.agreements;
  perform test_assert(v_count = 2, 'the owner sees their own agreements');
  select count(*) into v_count from public.agreement_signatures;
  perform test_assert(v_count >= 1, 'the owner sees signatures against their agreements');
  select count(*) into v_count from public.notices;
  perform test_assert(v_count = 1, 'the owner sees their own notices');
  reset role;
end $$;

do $$
declare v_count integer;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}';
  select count(*) into v_count from public.agreements;
  perform test_assert(v_count = 0, 'a stranger sees no agreements');
  select count(*) into v_count from public.agreement_signatures;
  perform test_assert(v_count = 0, 'a stranger sees no signatures');
  select count(*) into v_count from public.notices;
  perform test_assert(v_count = 0, 'a stranger sees no notices');
  reset role;
end $$;

do $$
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"88888888-8888-8888-8888-888888888888","role":"authenticated"}';

  begin
    perform access_token from public.agreement_signatures limit 1;
    perform test_assert(false, 'reading a signing token from the browser should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'signing tokens are not readable by the dashboard client');
  end;

  begin
    update public.agreement_signatures set signer_email = 'changed@example.dev'
    where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    perform test_assert(false, 'editing a signature record should be refused');
  exception when insufficient_privilege then
    perform test_assert(true, 'the owner has no grant to rewrite signature records');
  end;

  reset role;
end $$;

do $$
begin
  set local role anon;
  begin
    perform public.signature_view('deadbeef');
    perform test_assert(false, 'anon should not be able to call the signing functions');
  exception when insufficient_privilege then
    perform test_assert(true, 'the signing functions are reachable only by the service role');
  end;
  reset role;
end $$;

-- 5. Cascades ----------------------------------------------------------------

do $$
declare v_count integer;
begin
  delete from public.agreements where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  select count(*) into v_count from public.agreement_signatures
  where agreement_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  perform test_assert(v_count = 0, 'deleting an agreement removes its signature requests');
end $$;

delete from auth.users where email in ('owner@test.dev', 'stranger@test.dev');
drop function test_assert(boolean, text);

select 'ALL AGREEMENT TESTS PASSED' as result;
