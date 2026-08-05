import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/server';
import { createProject } from '@/lib/actions';
import { ActionForm, SubmitButton } from '@/components/form';
import { PROJECT_COLUMNS, type Project } from '@/lib/types';
import { StatusPill } from '@/components/status-pill';

export default async function DashboardPage() {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const { data } = await supabase
    .from('projects')
    .select(PROJECT_COLUMNS)
    .order('created_at', { ascending: false });

  const projects = (data ?? []) as Project[];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Protected domains</h1>
        <p className="hint">Traffic for these domains is routed through the FounderShield edge.</p>
      </div>

      {projects.length > 0 && (
        <ul className="space-y-3">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                href={`/dashboard/projects/${project.id}`}
                className="flex items-center justify-between rounded-xl border border-line bg-white px-5 py-4 transition hover:border-ink"
              >
                <div>
                  <p className="font-medium">{project.name}</p>
                  <p className="text-sm text-ink-faint">
                    {project.domain} → {project.origin_url}
                  </p>
                </div>
                <StatusPill status={project.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="card">
        <h2 className="text-base font-semibold">Add a domain</h2>
        <p className="hint">
          The origin is where your app actually runs. It must be a different hostname from the domain you are
          protecting, otherwise the proxy would forward to itself.
        </p>

        <ActionForm action={createProject} className="mt-5 space-y-4">
          <div>
            <label className="label" htmlFor="name">
              Project name
            </label>
            <input id="name" name="name" className="input" placeholder="Acme" required />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="domain">
                Domain to protect
              </label>
              <input id="domain" name="domain" className="input" placeholder="app.example.com" required />
            </div>
            <div>
              <label className="label" htmlFor="origin_url">
                Origin URL
              </label>
              <input
                id="origin_url"
                name="origin_url"
                className="input"
                placeholder="https://origin.example.com"
                required
              />
            </div>
          </div>

          <SubmitButton pendingLabel="Adding…">Add domain</SubmitButton>
        </ActionForm>
      </div>
    </div>
  );
}
