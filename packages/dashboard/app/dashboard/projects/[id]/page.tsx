import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/server';
import { edgeHostname } from '@/lib/edge';
import { deleteProject, updateProject, verifyDomain } from '@/lib/actions';
import { ActionForm, SubmitButton } from '@/components/form';
import { PROJECT_COLUMNS, type Project, type ProjectStats } from '@/lib/types';

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="card">
      <p className="text-sm text-ink-faint">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</p>
    </div>
  );
}

function DnsRow({ type, name, value }: { type: string; name: string; value: string }) {
  return (
    <tr className="border-t border-line align-top">
      <td className="py-2 pr-4 font-mono text-xs">{type}</td>
      <td className="py-2 pr-4 font-mono text-xs break-all">{name}</td>
      <td className="py-2 font-mono text-xs break-all">{value}</td>
    </tr>
  );
}

export default async function ProjectOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const { data } = await supabase.from('projects').select(PROJECT_COLUMNS).eq('id', id).single();
  if (!data) notFound();
  const project = data as Project;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: statsData } = await supabase.rpc('project_event_stats', {
    p_project_id: id,
    p_since: since,
  });
  const stats = (statsData ?? null) as ProjectStats | null;

  const setupComplete = project.status === 'active';

  return (
    <div className="space-y-6">
      {!setupComplete && (
        <section className="card border-amber-200 bg-amber-50/40">
          <h2 className="text-base font-semibold">Finish setup</h2>
          <p className="hint">
            Add both records at your DNS provider, then verify. The TXT record proves you control the domain; the CNAME
            routes traffic through the proxy. Nothing is enforced until traffic actually reaches us.
          </p>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="pb-2 pr-4 font-medium">Type</th>
                  <th className="pb-2 pr-4 font-medium">Name</th>
                  <th className="pb-2 font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                <DnsRow type="TXT" name={`_foundershield.${project.domain}`} value={`fs-verify=${project.verification_token}`} />
                <DnsRow type="CNAME" name={project.domain} value={edgeHostname()} />
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <span className={project.dns_verified_at ? 'text-emerald-700' : 'text-ink-faint'}>
              {project.dns_verified_at ? '✓ Ownership verified' : '• Ownership not verified'}
            </span>
            <span className={project.proxy_verified_at ? 'text-emerald-700' : 'text-ink-faint'}>
              {project.proxy_verified_at ? '✓ Traffic reaching proxy' : '• Traffic not reaching proxy'}
            </span>
          </div>

          <ActionForm action={verifyDomain} className="mt-4">
            <input type="hidden" name="project_id" value={project.id} />
            <SubmitButton pendingLabel="Checking DNS…">Verify now</SubmitButton>
          </ActionForm>
        </section>
      )}

      <section className="grid gap-4 sm:grid-cols-4">
        <Stat label="Requests (7d)" value={stats?.total ?? 0} />
        <Stat label="Blocked" value={stats?.blocked ?? 0} tone="text-red-700" />
        <Stat label="Challenged" value={stats?.challenged ?? 0} tone="text-amber-700" />
        <Stat label="Allowed" value={stats?.allowed ?? 0} />
      </section>

      {stats && stats.topIps.length > 0 && (
        <section className="card">
          <h2 className="text-base font-semibold">Most-stopped addresses (7 days)</h2>
          <table className="mt-3 w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th className="pb-2 font-medium">Address</th>
                <th className="pb-2 font-medium">Requests</th>
                <th className="pb-2 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {stats.topIps.map((row) => (
                <tr key={row.ip} className="border-t border-line">
                  <td className="py-2 font-mono text-xs">{row.ip}</td>
                  <td className="py-2 tabular-nums">{row.n}</td>
                  <td className="py-2 text-ink-faint">{new Date(row.last_seen).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2 className="text-base font-semibold">Routing</h2>
        <ActionForm action={updateProject} className="mt-4 space-y-4">
          <input type="hidden" name="project_id" value={project.id} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="name">
                Project name
              </label>
              <input id="name" name="name" className="input" defaultValue={project.name} />
            </div>
            <div>
              <label className="label" htmlFor="origin_url">
                Origin URL
              </label>
              <input id="origin_url" name="origin_url" className="input" defaultValue={project.origin_url} />
              <p className="hint">Where verified traffic is forwarded.</p>
            </div>
          </div>
          <SubmitButton>Save</SubmitButton>
        </ActionForm>
      </section>

      <section className="card border-red-200">
        <h2 className="text-base font-semibold">Remove domain</h2>
        <p className="hint">
          Deletes the project and every evidence record attached to it. If you may need those records later, export
          them from the Evidence tab first — this cannot be undone.
        </p>
        <form action={deleteProject} className="mt-4">
          <input type="hidden" name="project_id" value={project.id} />
          <button type="submit" className="btn-danger">
            Delete {project.domain}
          </button>
        </form>
      </section>
    </div>
  );
}
