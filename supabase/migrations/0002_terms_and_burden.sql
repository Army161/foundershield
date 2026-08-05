-- ===========================================================================
-- Phase 2 — generated terms, and per-actor burden analysis
--
-- Two additions:
--
--   * Clickwrap settings gain the inputs for terms FounderShield generates and
--     serves itself, plus how the notice is presented. Stored as inputs rather
--     than rendered text so the edge re-renders deterministically and the
--     version hash cannot drift from the document.
--
--   * `actor_burden()` aggregates what a single actor actually cost the server.
--     Phase 1 recorded per-request cost; nothing totalled it. Trespass to
--     chattels turns on demonstrable impairment (Intel v. Hamidi), so these are
--     the only numbers that theory can rest on — and if they are unremarkable,
--     that is worth knowing before anyone relies on the claim.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Clickwrap settings
-- ---------------------------------------------------------------------------

alter table public.protection_settings
  alter column clickwrap set default jsonb_build_object(
    'enabled', false,
    'version', '1',
    'tosUrl', '/terms',
    'requiredPaths', jsonb_build_array(),
    'terms', null,
    'presentation', 'interstitial',
    'serveRobotsTxt', false
  );

-- Backfill existing rows so the edge never sees a half-shaped record. The
-- normaliser would default these anyway; writing them makes the stored config
-- match what is actually enforced, which matters when it is read as evidence
-- of the settings in force at a given time.
update public.protection_settings
set clickwrap = clickwrap
  || jsonb_build_object('terms', coalesce(clickwrap->'terms', 'null'::jsonb))
  || jsonb_build_object('presentation', coalesce(clickwrap->>'presentation', 'interstitial'))
  || jsonb_build_object('serveRobotsTxt', coalesce((clickwrap->>'serveRobotsTxt')::boolean, false))
where not (clickwrap ? 'presentation' and clickwrap ? 'serveRobotsTxt' and clickwrap ? 'terms');

-- ---------------------------------------------------------------------------
-- Per-actor burden
-- ---------------------------------------------------------------------------

create or replace function public.actor_burden(
  p_project_id uuid,
  p_since      timestamptz,
  p_until      timestamptz default now()
)
returns table (
  ip                       text,
  ip_hash                  text,
  country                  text,
  as_organisation          text,
  requests                 bigint,
  blocked                  bigint,
  challenged               bigint,
  allowed                  bigint,
  bytes_served             bigint,
  origin_ms_total          bigint,
  first_seen               timestamptz,
  last_seen                timestamptz,
  active_seconds           numeric,
  mean_requests_per_minute numeric,
  peak_requests_per_minute bigint,
  distinct_paths           bigint,
  user_agents              text[],
  rule_ids                 text[]
)
language sql
security invoker
stable
as $$
  with scoped as (
    select * from public.request_events e
    where e.project_id = p_project_id
      and e.occurred_at >= p_since
      and e.occurred_at <= p_until
      and e.ip is not null
  ),
  per_minute as (
    select s.ip as addr, date_trunc('minute', s.occurred_at) as bucket, count(*) as n
    from scoped s group by 1, 2
  ),
  peaks as (
    select addr, max(n) as peak from per_minute group by 1
  ),
  rules as (
    select s.ip as addr, r.value->>'ruleId' as rule_id
    from scoped s, lateral jsonb_array_elements(s.reasons) r
    where r.value->>'ruleId' is not null
  )
  select
    host(s.ip),
    min(s.ip_hash),
    -- An actor can appear from more than one country via a proxy; report the
    -- most recent observation rather than pretending there is only one.
    (array_agg(s.country order by s.occurred_at desc) filter (where s.country is not null))[1],
    (array_agg(s.as_organisation order by s.occurred_at desc) filter (where s.as_organisation is not null))[1],
    count(*),
    count(*) filter (where s.action = 'block'),
    count(*) filter (where s.action = 'challenge'),
    count(*) filter (where s.action = 'allow'),
    coalesce(sum(s.response_bytes), 0),
    coalesce(sum(s.origin_ms), 0),
    min(s.occurred_at),
    max(s.occurred_at),
    round(extract(epoch from (max(s.occurred_at) - min(s.occurred_at)))::numeric, 1),
    case
      when max(s.occurred_at) = min(s.occurred_at) then count(*)::numeric
      else round(
        count(*)::numeric / greatest(extract(epoch from (max(s.occurred_at) - min(s.occurred_at)))::numeric / 60, 1),
        2)
    end,
    coalesce((select p.peak from peaks p where p.addr = s.ip), 0),
    count(distinct s.path),
    (select array_agg(distinct t.user_agent) from scoped t where t.ip = s.ip),
    (select array_agg(distinct r.rule_id) from rules r where r.addr = s.ip)
  from scoped s
  group by s.ip
  order by count(*) desc;
$$;

revoke all on function public.actor_burden(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.actor_burden(uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Report header
--
-- One call returning everything a report needs about the project itself, so the
-- report page cannot accidentally render a header from one project and a body
-- from another.
-- ---------------------------------------------------------------------------

create or replace function public.evidence_report_header(
  p_project_id uuid,
  p_since      timestamptz,
  p_until      timestamptz default now()
)
returns jsonb
language sql
security invoker
stable
as $$
  select jsonb_build_object(
    'project', jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'domain', p.domain,
      'originUrl', p.origin_url,
      'status', p.status,
      'createdAt', p.created_at,
      'dnsVerifiedAt', p.dns_verified_at,
      'proxyVerifiedAt', p.proxy_verified_at
    ),
    -- The policy as it stands now. Stated as such in the report: it is not
    -- necessarily the policy that was in force for every event in the range.
    'settingsNow', jsonb_build_object(
      'mode', s.mode,
      'tpm', s.tpm,
      'rateLimit', s.rate_limit,
      'bots', s.bots,
      'authGate', s.auth_gate,
      'clickwrap', s.clickwrap
    ),
    'window', jsonb_build_object('since', p_since, 'until', p_until),
    'totals', jsonb_build_object(
      'events',     (select count(*) from public.request_events e
                     where e.project_id = p.id and e.occurred_at between p_since and p_until),
      'blocked',    (select count(*) from public.request_events e
                     where e.project_id = p.id and e.occurred_at between p_since and p_until and e.action = 'block'),
      'challenged', (select count(*) from public.request_events e
                     where e.project_id = p.id and e.occurred_at between p_since and p_until and e.action = 'challenge'),
      'enforced',   (select count(*) from public.request_events e
                     where e.project_id = p.id and e.occurred_at between p_since and p_until
                       and e.action <> 'allow' and e.enforced),
      'actors',     (select count(distinct e.ip) from public.request_events e
                     where e.project_id = p.id and e.occurred_at between p_since and p_until and e.ip is not null),
      'bytesServed',(select coalesce(sum(e.response_bytes), 0) from public.request_events e
                     where e.project_id = p.id and e.occurred_at between p_since and p_until),
      'originMs',   (select coalesce(sum(e.origin_ms), 0) from public.request_events e
                     where e.project_id = p.id and e.occurred_at between p_since and p_until)
    ),
    'seals', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', v.id, 'fromEvent', v.from_event, 'toEvent', v.to_event,
        'eventCount', v.event_count, 'digest', v.digest, 'sealedAt', v.sealed_at
      ) order by v.sealed_at), '[]'::jsonb)
      from public.evidence_seals v where v.project_id = p.id
    )
  )
  from public.projects p
  left join public.protection_settings s on s.project_id = p.id
  where p.id = p_project_id;
$$;

revoke all on function public.evidence_report_header(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.evidence_report_header(uuid, timestamptz, timestamptz) to authenticated;
