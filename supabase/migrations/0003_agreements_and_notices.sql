-- ===========================================================================
-- Phase 3 — agreements (DTSA layer) and drafted notices
--
-- Agreements hang off the *user*, not a project: an NDA covers a company and
-- its contractors, not a hostname. Notices hang off a project, because they
-- describe activity against a specific domain.
--
-- The signature model is deliberately modest. It records assent — who, when,
-- from where, and against which exact document version — in the same shape as
-- the clickwrap record. It is not a qualified electronic signature service and
-- the dashboard does not claim otherwise.
-- ===========================================================================

create extension if not exists pgcrypto with schema extensions;

do $$ begin
  create type agreement_kind as enum ('nda');
exception when duplicate_object then null; end $$;

do $$ begin
  create type signature_status as enum ('pending', 'viewed', 'signed', 'declined', 'revoked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type notice_kind as enum ('dmca-512', 'circumvention', 'access');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Agreements
-- ---------------------------------------------------------------------------

create table if not exists public.agreements (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  kind        agreement_kind not null default 'nda',
  name        text not null check (char_length(name) between 1 and 120),

  -- Content hash of the rendered document. A signature references this, so a
  -- later edit produces a different version and cannot inherit old signatures.
  version     text not null,
  /** Generator inputs, so the document can be re-rendered and re-checked. */
  input       jsonb not null,
  /** The exact text presented for signature. Frozen once signatures exist. */
  body        text not null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists agreements_user_idx on public.agreements (user_id, created_at desc);

drop trigger if exists agreements_touch on public.agreements;
create trigger agreements_touch before update on public.agreements
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Signatures
-- ---------------------------------------------------------------------------

create table if not exists public.agreement_signatures (
  id             uuid primary key default gen_random_uuid(),
  agreement_id   uuid not null references public.agreements (id) on delete cascade,

  signer_name    text not null check (char_length(signer_name) between 1 and 120),
  signer_email   text not null,

  -- Unguessable link the signer opens. Not a credential: it proves only that
  -- whoever holds it was sent it, which is what a signing link ever proves.
  access_token   text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),

  status         signature_status not null default 'pending',

  -- The version of the agreement that was actually presented. Pinned at issue
  -- time so amending the agreement cannot retroactively change what was signed.
  signed_version text not null,

  sent_at        timestamptz not null default now(),
  viewed_at      timestamptz,
  signed_at      timestamptz,
  declined_at    timestamptz,

  -- Recorded at the moment of signature.
  signature_ip   inet,
  signature_ua   text,
  /** Name the signer typed, which may differ from the name they were sent as. */
  typed_name     text,
  /** sha-256 of the exact body signed, so the document cannot be swapped later. */
  body_hash      text,

  created_at     timestamptz not null default now()
);

create index if not exists agreement_signatures_agreement_idx
  on public.agreement_signatures (agreement_id, created_at desc);

-- A signature is a record of a past event. Once signed or declined it is
-- closed: the only permitted transition afterwards is revoking the *request*,
-- which does not erase what happened.
create or replace function public.guard_signature_update()
returns trigger language plpgsql as $$
begin
  if old.status in ('signed', 'declined') and new.status is distinct from old.status then
    raise exception 'a % signature cannot be changed', old.status;
  end if;

  if old.status = 'signed' then
    if new.signed_at is distinct from old.signed_at
       or new.typed_name is distinct from old.typed_name
       or new.body_hash is distinct from old.body_hash
       or new.signed_version is distinct from old.signed_version
       or new.signature_ip is distinct from old.signature_ip then
      raise exception 'the record of a completed signature is immutable';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists agreement_signatures_guard on public.agreement_signatures;
create trigger agreement_signatures_guard
  before update on public.agreement_signatures
  for each row execute function public.guard_signature_update();

-- An agreement that has been signed by anyone is frozen. Editing it would mean
-- the signed record no longer matches any document that exists.
create or replace function public.guard_agreement_update()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from public.agreement_signatures s
    where s.agreement_id = old.id and s.status = 'signed'
  ) and (new.body is distinct from old.body or new.version is distinct from old.version) then
    raise exception 'this agreement has been signed and can no longer be edited; create a new version instead';
  end if;
  return new;
end;
$$;

drop trigger if exists agreements_guard on public.agreements;
create trigger agreements_guard
  before update on public.agreements
  for each row execute function public.guard_agreement_update();

-- ---------------------------------------------------------------------------
-- Drafted notices
-- ---------------------------------------------------------------------------

create table if not exists public.notices (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  kind        notice_kind not null,

  addressee   text not null,
  subject     text not null,
  body        text not null,
  /** The cautions shown when it was drafted, kept with it. */
  cautions    jsonb not null default '[]'::jsonb,
  /** Inputs and the incidents cited, so the draft can be explained later. */
  context     jsonb not null default '{}'::jsonb,

  -- FounderShield never sends. This is the operator recording that they did,
  -- so the file reflects reality; it is not a send button.
  marked_sent_at timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists notices_project_idx on public.notices (project_id, created_at desc);

drop trigger if exists notices_touch on public.notices;
create trigger notices_touch before update on public.notices
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Signing, from the signer's side
--
-- The signer is not a Supabase user and never will be, so these run as the
-- service role behind a server action that has validated the token. They are
-- SECURITY DEFINER and take the token rather than an id, so holding a link
-- grants exactly one capability and nothing else.
-- ---------------------------------------------------------------------------

create or replace function public.signature_view(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signature public.agreement_signatures;
  v_agreement public.agreements;
begin
  select * into v_signature from public.agreement_signatures where access_token = p_token;
  if v_signature.id is null then return null; end if;

  select * into v_agreement from public.agreements where id = v_signature.agreement_id;

  if v_signature.status = 'pending' then
    update public.agreement_signatures
    set status = 'viewed', viewed_at = coalesce(viewed_at, now())
    where id = v_signature.id;
    v_signature.status := 'viewed';
  end if;

  return jsonb_build_object(
    'signatureId', v_signature.id,
    'status', v_signature.status,
    'signerName', v_signature.signer_name,
    'signerEmail', v_signature.signer_email,
    'signedAt', v_signature.signed_at,
    'typedName', v_signature.typed_name,
    'agreementName', v_agreement.name,
    'version', v_signature.signed_version,
    'body', v_agreement.body
  );
end;
$$;

create or replace function public.signature_sign(
  p_token      text,
  p_typed_name text,
  p_ip         text,
  p_user_agent text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signature public.agreement_signatures;
  v_agreement public.agreements;
  v_hash      text;
begin
  select * into v_signature from public.agreement_signatures where access_token = p_token;
  if v_signature.id is null then
    raise exception 'unknown signing link';
  end if;
  if v_signature.status = 'signed' then
    raise exception 'already signed';
  end if;
  if v_signature.status in ('declined', 'revoked') then
    raise exception 'this signing link is no longer active';
  end if;
  if coalesce(trim(p_typed_name), '') = '' then
    raise exception 'a name is required';
  end if;

  select * into v_agreement from public.agreements where id = v_signature.agreement_id;

  -- Hash the exact text signed. If the agreement is ever altered, this no
  -- longer matches, which is the point.
  v_hash := encode(sha256(convert_to(v_agreement.body, 'UTF8')), 'hex');

  update public.agreement_signatures
  set status = 'signed',
      signed_at = now(),
      typed_name = trim(p_typed_name),
      signature_ip = nullif(p_ip, '')::inet,
      signature_ua = p_user_agent,
      body_hash = v_hash
  where id = v_signature.id;

  return jsonb_build_object('ok', true, 'signedAt', now(), 'bodyHash', v_hash);
end;
$$;

create or replace function public.signature_decline(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_signature public.agreement_signatures;
begin
  select * into v_signature from public.agreement_signatures where access_token = p_token;
  if v_signature.id is null then raise exception 'unknown signing link'; end if;
  if v_signature.status = 'signed' then raise exception 'already signed'; end if;

  update public.agreement_signatures
  set status = 'declined', declined_at = now()
  where id = v_signature.id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.signature_view(text)                       from public, anon, authenticated;
revoke all on function public.signature_sign(text, text, text, text)     from public, anon, authenticated;
revoke all on function public.signature_decline(text)                    from public, anon, authenticated;
grant execute on function public.signature_view(text)                    to service_role;
grant execute on function public.signature_sign(text, text, text, text)  to service_role;
grant execute on function public.signature_decline(text)                 to service_role;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.agreements            enable row level security;
alter table public.agreement_signatures  enable row level security;
alter table public.notices               enable row level security;

drop policy if exists agreements_owner_all on public.agreements;
create policy agreements_owner_all on public.agreements
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists signatures_owner_all on public.agreement_signatures;
create policy signatures_owner_all on public.agreement_signatures
  for all to authenticated
  using (exists (select 1 from public.agreements a where a.id = agreement_id and a.user_id = auth.uid()))
  with check (exists (select 1 from public.agreements a where a.id = agreement_id and a.user_id = auth.uid()));

drop policy if exists notices_owner_all on public.notices;
create policy notices_owner_all on public.notices
  for all to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Grants — explicit, for the reasons set out in 0001
-- ---------------------------------------------------------------------------

revoke all on public.agreements           from authenticated, anon;
revoke all on public.agreement_signatures from authenticated, anon;
revoke all on public.notices              from authenticated, anon;

grant select, insert, update, delete on public.agreements to authenticated;

-- No update grant: an owner issues and revokes signature requests, but must not
-- be able to edit the record of one. Revocation goes through a column grant.
grant select, insert, delete on public.agreement_signatures to authenticated;
grant update (status) on public.agreement_signatures to authenticated;

-- `access_token` is deliberately absent from the authenticated select grant:
-- the dashboard builds signing links server-side, so the browser never needs
-- to hold one.
revoke select on public.agreement_signatures from authenticated;
grant select (
  id, agreement_id, signer_name, signer_email, status, signed_version,
  sent_at, viewed_at, signed_at, declined_at, signature_ip, signature_ua,
  typed_name, body_hash, created_at
) on public.agreement_signatures to authenticated;

grant select, insert, update, delete on public.notices to authenticated;

grant all on public.agreements           to service_role;
grant all on public.agreement_signatures to service_role;
grant all on public.notices              to service_role;
grant usage, select on all sequences in schema public to service_role;
