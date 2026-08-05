import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/server';
import type { ActorBurden, EvidenceReportHeader, SealVerification } from '@/lib/types';

export const metadata = { title: 'Evidence report' };

const WINDOWS: Record<string, { days: number; label: string }> = {
  '7': { days: 7, label: 'last 7 days' },
  '30': { days: 30, label: 'last 30 days' },
  '90': { days: 90, label: 'last 90 days' },
  '365': { days: 365, label: 'last 12 months' },
};

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function utc(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

export default async function EvidenceReport({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ window?: string }>;
}) {
  const { id } = await params;
  const { window: windowKey = '30' } = await searchParams;
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const chosen = WINDOWS[windowKey] ?? WINDOWS['30']!;
  const until = new Date();
  const since = new Date(until.getTime() - chosen.days * 24 * 60 * 60 * 1000);

  const [{ data: headerData }, { data: burdenData }] = await Promise.all([
    supabase.rpc('evidence_report_header', {
      p_project_id: id,
      p_since: since.toISOString(),
      p_until: until.toISOString(),
    }),
    supabase.rpc('actor_burden', {
      p_project_id: id,
      p_since: since.toISOString(),
      p_until: until.toISOString(),
    }),
  ]);

  if (!headerData) notFound();
  const header = headerData as EvidenceReportHeader;
  const burden = (burdenData ?? []) as ActorBurden[];

  // Re-verify every seal at render time. A report that simply asserts the log
  // is intact is worth nothing; this one checks and prints the result either
  // way, including when the answer is bad.
  const verifications: SealVerification[] = [];
  for (const seal of header.seals) {
    const { data } = await supabase.rpc('verify_evidence_seal', { p_seal_id: seal.id });
    if (data) verifications.push(data as SealVerification);
  }
  const compromised = verifications.filter((v) => !v.intact);

  const stopped = burden.filter((actor) => actor.blocked + actor.challenged > 0);

  return (
    <article className="report space-y-8 bg-white p-8 text-ink">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .report { padding: 0 !important; }
          section { break-inside: avoid; }
          a[href]:after { content: ""; }
        }
        .report table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .report th { text-align: left; font-weight: 600; padding: 6px 8px; border-bottom: 1px solid #e6e6ec; }
        .report td { padding: 6px 8px; border-bottom: 1px solid #f0f0f4; vertical-align: top; }
        .report h2 { font-size: 1rem; font-weight: 600; margin: 0 0 .5rem; }
        .report h3 { font-size: .9rem; font-weight: 600; margin: 1rem 0 .35rem; }
      `}</style>

      <div className="no-print flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface px-4 py-3">
        <div className="flex gap-2">
          {Object.entries(WINDOWS).map(([key, value]) => (
            <a
              key={key}
              href={`?window=${key}`}
              className={`rounded-md border px-2.5 py-1 text-sm ${
                key === windowKey ? 'border-ink bg-ink text-white' : 'border-line bg-white text-ink-soft'
              }`}
            >
              {value.label}
            </a>
          ))}
        </div>
        <p className="text-sm text-ink-faint">Use your browser&rsquo;s print dialog to save as PDF.</p>
      </div>

      <header className="border-b border-line pb-6">
        <p className="text-xs uppercase tracking-widest text-ink-faint">Access control report</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{header.project.domain}</h1>
        <dl className="mt-4 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-ink-faint">Operator of record</dt>
            <dd>{header.project.name}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-ink-faint">Origin</dt>
            <dd className="font-mono text-xs">{header.project.originUrl}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-ink-faint">Period covered</dt>
            <dd>
              {utc(header.window.since)} &ndash; {utc(header.window.until)}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-ink-faint">Report generated</dt>
            <dd>{utc(new Date().toISOString())}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-ink-faint">Protection active since</dt>
            <dd>{header.project.proxyVerifiedAt ? utc(header.project.proxyVerifiedAt) : 'not yet verified'}</dd>
          </div>
        </dl>
      </header>

      <section>
        <h2>1. How these records were produced</h2>
        <p className="text-sm text-ink-soft">
          Traffic for {header.project.domain} is routed through a reverse proxy operated by FounderShield before it
          reaches the origin server. The proxy evaluates each request against the access controls configured by the
          operator and records the outcome automatically, at the time of the request, without human involvement.
        </p>
        <p className="mt-2 text-sm text-ink-soft">
          Each record separates what was <em>observed</em> — the network address, timestamp, requested path, headers
          presented — from the system&rsquo;s <em>interpretation</em> of it. Records are written by the proxy alone: the
          database grants no insert, update or delete privilege on them to the account that owns this project, so they
          cannot be added to or altered from the dashboard.
        </p>
      </section>

      <section>
        <h2>2. Integrity of the record</h2>
        {verifications.length === 0 ? (
          <p className="text-sm text-ink-soft">
            No seals have been created for this project. Individual records still carry a hash computed when they were
            written, but no range has been fixed, so this report cannot demonstrate that the set is unchanged since a
            point in time. Sealing before a dispute arises is materially more useful than sealing after.
          </p>
        ) : (
          <>
            <p className="text-sm text-ink-soft">
              Each record is hashed on write from its own contents. Seals fix a closed range of records and chain to the
              seal before them. Every seal below was re-verified when this report was generated, by recomputing each
              record&rsquo;s hash from its current contents and comparing the chained digest against the stored value.
            </p>
            {compromised.length > 0 && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900">
                <strong>{compromised.length} of {verifications.length} seals did not verify.</strong> Records inside
                those ranges have changed since they were sealed. This report should not be relied on without
                establishing why.
              </p>
            )}
            <table className="mt-3">
              <thead>
                <tr>
                  <th>Sealed</th>
                  <th>Records</th>
                  <th>Verified</th>
                  <th>Digest</th>
                </tr>
              </thead>
              <tbody>
                {verifications.map((v) => (
                  <tr key={v.sealId}>
                    <td>{utc(v.sealedAt)}</td>
                    <td>
                      {v.actualCount}
                      {v.actualCount !== v.expectedCount && ` of ${v.expectedCount} expected`}
                    </td>
                    <td className={v.intact ? 'text-emerald-700' : 'text-red-700'}>
                      {v.intact ? 'Intact' : `Altered (${v.alteredRows} record${v.alteredRows === 1 ? '' : 's'})`}
                    </td>
                    <td className="break-all font-mono text-[11px]">{v.expectedDigest.slice(0, 32)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section>
        <h2>3. Summary for the period</h2>
        <table>
          <tbody>
            <tr>
              <td>Requests recorded</td>
              <td className="tabular-nums">{header.totals.events.toLocaleString()}</td>
            </tr>
            <tr>
              <td>Refused</td>
              <td className="tabular-nums">{header.totals.blocked.toLocaleString()}</td>
            </tr>
            <tr>
              <td>Challenged</td>
              <td className="tabular-nums">{header.totals.challenged.toLocaleString()}</td>
            </tr>
            <tr>
              <td>Refusals actually enforced</td>
              <td className="tabular-nums">
                {header.totals.enforced.toLocaleString()}
                {header.totals.enforced < header.totals.blocked + header.totals.challenged && (
                  <span className="ml-2 text-ink-faint">
                    (the remainder were recorded in monitoring mode and not enforced)
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <td>Distinct addresses</td>
              <td className="tabular-nums">{header.totals.actors.toLocaleString()}</td>
            </tr>
            <tr>
              <td>Data served</td>
              <td className="tabular-nums">{bytes(header.totals.bytesServed)}</td>
            </tr>
            <tr>
              <td>Origin server time consumed</td>
              <td className="tabular-nums">{duration(header.totals.originMs)}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs text-ink-faint">
          Refused and challenged requests are always recorded. Ordinary traffic is sampled, so totals for allowed
          requests understate real volume by design.
        </p>
      </section>

      <section>
        <h2>4. Load attributable to individual actors</h2>
        <p className="text-sm text-ink-soft">
          Per-address totals for the period, ranked by request volume. Peak rate is the largest number of requests seen
          from that address in any single minute.
        </p>
        {burden.length === 0 ? (
          <p className="mt-3 text-sm text-ink-faint">No addressable activity recorded in this period.</p>
        ) : (
          <table className="mt-3">
            <thead>
              <tr>
                <th>Address</th>
                <th>Network</th>
                <th className="text-right">Requests</th>
                <th className="text-right">Refused</th>
                <th className="text-right">Peak/min</th>
                <th className="text-right">Paths</th>
                <th className="text-right">Data</th>
                <th className="text-right">Origin time</th>
                <th>First &ndash; last seen</th>
              </tr>
            </thead>
            <tbody>
              {burden.slice(0, 50).map((actor) => (
                <tr key={actor.ip}>
                  <td className="font-mono text-[11px]">{actor.ip}</td>
                  <td>
                    {actor.as_organisation ?? '—'}
                    {actor.country && <span className="ml-1 text-ink-faint">{actor.country}</span>}
                  </td>
                  <td className="text-right tabular-nums">{actor.requests.toLocaleString()}</td>
                  <td className="text-right tabular-nums">{actor.blocked.toLocaleString()}</td>
                  <td className="text-right tabular-nums">{actor.peak_requests_per_minute}</td>
                  <td className="text-right tabular-nums">{actor.distinct_paths}</td>
                  <td className="text-right tabular-nums">{bytes(actor.bytes_served)}</td>
                  <td className="text-right tabular-nums">{duration(actor.origin_ms_total)}</td>
                  <td className="whitespace-nowrap text-[11px]">
                    {utc(actor.first_seen)}
                    <br />
                    {utc(actor.last_seen)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {burden.length > 50 && (
          <p className="mt-2 text-xs text-ink-faint">
            Showing the 50 highest-volume addresses of {burden.length}. The full set is in the CSV export.
          </p>
        )}
      </section>

      {stopped.length > 0 && (
        <section>
          <h2>5. Controls triggered, by actor</h2>
          <p className="text-sm text-ink-soft">
            Which measures each stopped actor encountered. Descriptions are the system&rsquo;s own, recorded at the time
            of the request.
          </p>
          <table className="mt-3">
            <thead>
              <tr>
                <th>Address</th>
                <th>Rules triggered</th>
                <th>User-agents presented</th>
              </tr>
            </thead>
            <tbody>
              {stopped.slice(0, 25).map((actor) => (
                <tr key={actor.ip}>
                  <td className="font-mono text-[11px]">{actor.ip}</td>
                  <td className="font-mono text-[11px]">{(actor.rule_ids ?? []).join(', ') || '—'}</td>
                  <td className="text-[11px]">{(actor.user_agents ?? []).slice(0, 4).join(' | ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="border-t border-line pt-6">
        <h2>6. Limitations</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-soft">
          <li>
            This is a record of what the proxy observed and did. It is not a legal conclusion, and nothing in it
            establishes that any particular access was unlawful.
          </li>
          <li>
            The seals demonstrate internal consistency — that records have not changed since they were sealed. They do
            not establish that the data was accurate when written, and they are generated by the same system that wrote
            the records.
          </li>
          <li>
            Network addresses identify a connection, not a person or an organisation. Addresses are shared, reassigned,
            and routed through intermediaries.
          </li>
          <li>
            The policy summarised in this report is the policy in force <em>now</em>. Settings may have differed earlier
            in the period.
          </li>
          <li>
            Allowed traffic is sampled, so totals understate real volume. Refused and challenged requests are complete.
          </li>
          <li>
            Take this to a lawyer before acting on it. Whether the activity described here breaches any terms or gives
            rise to a claim depends on facts and law beyond what a proxy can observe.
          </li>
        </ul>
      </section>
    </article>
  );
}
