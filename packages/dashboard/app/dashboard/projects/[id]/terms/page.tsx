import { notFound, redirect } from 'next/navigation';
import { generateTerms, renderTermsText, DEFAULT_TERMS_INPUT } from '@foundershield/shared';
import { requireUser } from '@/lib/supabase/server';
import { updateTerms } from '@/lib/actions';
import { ActionForm, Field, SubmitButton, TextArea, Toggle } from '@/components/form';
import { PROJECT_COLUMNS, type Project, type ProtectionSettings } from '@/lib/types';

export default async function TermsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const [{ data: projectRow }, { data: settingsRow }] = await Promise.all([
    supabase.from('projects').select(PROJECT_COLUMNS).eq('id', id).single(),
    supabase.from('protection_settings').select('*').eq('project_id', id).single(),
  ]);

  if (!projectRow || !settingsRow) notFound();
  const project = projectRow as Project;
  const settings = settingsRow as ProtectionSettings;

  const terms = settings.clickwrap.terms;
  const input = terms ?? { ...DEFAULT_TERMS_INPUT, domain: project.domain, effectiveDate: new Date().toISOString().slice(0, 10) };
  const preview = terms ? await generateTerms(terms) : null;

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="text-base font-semibold">Terms of use</h2>
        <p className="hint">
          FounderShield can generate terms that describe the access controls this site actually enforces, then serve
          them at <code className="font-mono text-xs">/__fs/v1/terms</code> and show them in the acceptance gate.
        </p>
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>This is a template, not legal advice.</strong> It is a solid starting point that matches what the
          proxy does, but it has not been reviewed for your business, your jurisdiction, or your risk. Have a lawyer
          read it before you rely on it.
        </div>

        <ActionForm action={updateTerms} className="mt-5 space-y-5">
          <input type="hidden" name="project_id" value={id} />

          <Toggle
            name="cw_enabled"
            label="Require visitors to accept the terms"
            defaultChecked={settings.clickwrap.enabled}
          />

          <Toggle
            name="use_generated"
            label="Generate and host the terms for me"
            hint="Turn this off to keep pointing at terms you host yourself."
            defaultChecked={Boolean(terms)}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="site_name" label="Site name" defaultValue={input.siteName} hint="What people call your site." />
            <Field
              name="operator"
              label="Legal entity"
              defaultValue={input.operator}
              hint="The company or person the agreement is with."
            />
            <Field name="contact_email" label="Contact address" type="email" defaultValue={input.contactEmail} />
            <Field
              name="jurisdiction"
              label="Governing law"
              defaultValue={input.jurisdiction}
              hint="e.g. England and Wales, or the State of Delaware."
            />
            <Field name="effective_date" label="Effective from" type="date" defaultValue={input.effectiveDate} />
            <Field
              name="tos_url"
              label="Your own terms URL"
              defaultValue={settings.clickwrap.tosUrl}
              hint="Used only when generation is off."
            />
          </div>

          <div className="space-y-1 border-t border-line pt-4">
            <Toggle
              name="permit_ai"
              label="Allow this content to be used for AI training"
              hint="Off by default. When off, the terms expressly reserve rights and refuse text and data mining, and the same refusal is published in machine-readable form."
              defaultChecked={input.permitAiTraining}
            />
            <Toggle
              name="permit_indexing"
              label="Allow search engines to index the site"
              hint="Turning this off will cost you search traffic."
              defaultChecked={input.permitSearchIndexing}
            />
            <Toggle
              name="serve_robots"
              label="Also serve robots.txt from FounderShield"
              hint="Replaces your origin's robots.txt with one matching these settings. Leave off if you already maintain your own."
              defaultChecked={settings.clickwrap.serveRobotsTxt}
            />
          </div>

          <TextArea
            name="permitted_agents"
            label="Crawlers you allow"
            defaultValue={input.permittedAgents.join('\n')}
            rows={3}
            hint="One per line. The terms permit these for search indexing only."
          />

          <div className="border-t border-line pt-4">
            <p className="label">How the notice is shown</p>
            <div className="mt-2 space-y-2">
              <label className="flex items-start gap-3 rounded-lg border border-line p-3">
                <input
                  type="radio"
                  name="presentation"
                  value="interstitial"
                  defaultChecked={settings.clickwrap.presentation !== 'modal'}
                  className="mt-1 h-4 w-4 accent-ink"
                />
                <span>
                  <span className="text-sm font-medium">Withhold the page until accepted</span>
                  <span className="block text-sm text-ink-faint">
                    Nothing is served until the visitor clicks. This is the only option that actually controls access.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-line p-3">
                <input
                  type="radio"
                  name="presentation"
                  value="modal"
                  defaultChecked={settings.clickwrap.presentation === 'modal'}
                  className="mt-1 h-4 w-4 accent-ink"
                />
                <span>
                  <span className="text-sm font-medium">Overlay the page with a notice</span>
                  <span className="block text-sm text-ink-faint">
                    Looks better, but the page has already been sent. A client that ignores the overlay still has the
                    content, so this supports the contract and nothing more.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <SubmitButton>Save terms</SubmitButton>
        </ActionForm>
      </section>

      {preview && (
        <section className="card">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">Preview</h2>
            <p className="text-sm text-ink-faint">
              Version <code className="font-mono text-xs">{preview.version}</code>
            </p>
          </div>
          <p className="hint">
            The version is a hash of the text below. Change any wording and the version changes with it, so everyone who
            accepted the old wording is asked again. You cannot quietly alter terms someone already agreed to.
          </p>
          <pre className="mt-4 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-4 font-mono text-xs leading-relaxed">
            {renderTermsText(preview)}
          </pre>
        </section>
      )}
    </div>
  );
}
