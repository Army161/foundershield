-- ===========================================================================
-- Harden function definitions
--
-- Both issues here were surfaced by Supabase's database linter against a
-- hosted project, and neither shows up locally — which is the argument for
-- running the linter as part of deployment rather than trusting a local pass.
--
-- 1. Trigger functions were EXECUTE-able over the REST API.
--
--    PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Supabase
--    exposes every function in `public` at /rest/v1/rpc/<name>, so a trigger
--    function that nobody should ever call directly was callable by `anon`.
--    `create_default_settings` is SECURITY DEFINER, which makes it the one that
--    matters most: calling it directly errors out (a trigger function has no
--    trigger context), so this was not exploitable as written — but "not
--    exploitable because of how it fails" is not a security property worth
--    relying on. Trigger functions are invoked by triggers; nothing else needs
--    to reach them.
--
-- 2. Functions had a mutable search_path.
--
--    A function without a fixed `search_path` resolves unqualified names using
--    the caller's setting. Where an attacker can create objects in a schema
--    that gets searched first, that is a hijack. It matters most for SECURITY
--    DEFINER functions, but it is cheap to fix everywhere and there is no
--    reason to leave it uneven.
--
--    Set with ALTER rather than by recreating each function: the bodies are
--    unchanged, and rewriting them here would duplicate ~200 lines of logic
--    that would then have to be kept in step with the migration that defines
--    it. `pg_catalog` is always searched implicitly, so `public` alone is
--    sufficient for these.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Trigger functions are not an API
-- ---------------------------------------------------------------------------

revoke execute on function public.compute_event_hash()      from public, anon, authenticated;
revoke execute on function public.touch_updated_at()        from public, anon, authenticated;
revoke execute on function public.create_default_settings() from public, anon, authenticated;
revoke execute on function public.guard_signature_update()  from public, anon, authenticated;
revoke execute on function public.guard_agreement_update()  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Pin search_path
-- ---------------------------------------------------------------------------

alter function public.event_row_hash(public.request_events)                    set search_path = public;
alter function public.compute_event_hash()                                     set search_path = public;
alter function public.touch_updated_at()                                       set search_path = public;
alter function public.seal_evidence(uuid)                                      set search_path = public;
alter function public.verify_evidence_seal(uuid)                               set search_path = public;
alter function public.project_event_stats(uuid, timestamptz)                   set search_path = public;
alter function public.actor_burden(uuid, timestamptz, timestamptz)             set search_path = public;
alter function public.evidence_report_header(uuid, timestamptz, timestamptz)   set search_path = public;
alter function public.guard_signature_update()                                 set search_path = public;
alter function public.guard_agreement_update()                                 set search_path = public;
alter function public.account_usage(uuid, timestamptz)                         set search_path = public;

-- ---------------------------------------------------------------------------
-- Note on `stripe_events`
--
-- The linter reports it as "RLS enabled, no policy". That is deliberate and
-- correct: RLS with no policy denies every role that RLS applies to, and only
-- the service role — which bypasses RLS — writes the webhook ledger. A policy
-- here would widen access, not restrict it. Left as is on purpose.
-- ---------------------------------------------------------------------------
