import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/server';
import { updateProtectedRoutes } from '@/lib/actions';
import { ActionForm, Field, SubmitButton, TextArea, Toggle } from '@/components/form';
import type { ProtectionSettings } from '@/lib/types';

const MODE_HELP: Array<{ mode: string; description: string }> = [
  { mode: 'session', description: 'Requires your app’s own login cookie to be present.' },
  { mode: 'deny', description: 'Closed to all external traffic. Nothing gets through.' },
  { mode: 'apikey', description: 'Requires an issued key in the X-FS-Key header.' },
  { mode: 'ip_allowlist', description: 'Restricted to the CIDR ranges you list.' },
  { mode: 'clickwrap', description: 'Requires the visitor to have accepted your terms.' },
];

export default async function RoutesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const { data } = await supabase.from('protection_settings').select('*').eq('project_id', id).single();
  if (!data) notFound();
  const settings = data as ProtectionSettings;

  const serialised = settings.auth_gate.routes
    .map((route) => [route.pattern, route.mode, route.label].filter(Boolean).join(' '))
    .join('\n');

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="text-base font-semibold">Authorisation boundary</h2>
        <p className="hint">
          Routes listed here are closed by default and open only to requests that satisfy the stated condition. This is
          the difference between content that is merely published and content that is access-controlled — which is the
          distinction that matters most if you ever have to act on a scraping incident.
        </p>

        <ActionForm action={updateProtectedRoutes} className="mt-5 space-y-4">
          <input type="hidden" name="project_id" value={id} />

          <Toggle
            name="gate_enabled"
            label="Enforce protected routes"
            defaultChecked={settings.auth_gate.enabled}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              name="gate_cookie"
              label="Your session cookie name"
              defaultValue={settings.auth_gate.authCookieName}
              hint="The cookie your app sets once a user signs in."
            />
            <Field name="gate_login" label="Login path" defaultValue={settings.auth_gate.loginPath} />
          </div>

          <TextArea
            name="routes"
            label="Routes"
            rows={8}
            defaultValue={serialised}
            placeholder={'/api/private/** session Private API\n/internal/** deny\n/partners/** ip_allowlist'}
            hint="One per line: pattern, then mode, then an optional label."
          />

          <SubmitButton>Save routes</SubmitButton>
        </ActionForm>
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">Modes</h2>
        <dl className="mt-3 space-y-2 text-sm">
          {MODE_HELP.map((entry) => (
            <div key={entry.mode} className="flex gap-3">
              <dt className="w-32 shrink-0 font-mono text-xs">{entry.mode}</dt>
              <dd className="text-ink-soft">{entry.description}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
