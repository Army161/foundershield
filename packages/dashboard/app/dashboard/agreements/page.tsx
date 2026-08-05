import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/server';
import { createAgreement } from '@/lib/agreements';
import { ActionForm, Field, SubmitButton, Toggle } from '@/components/form';

interface AgreementRow {
  id: string;
  name: string;
  version: string;
  created_at: string;
}

export default async function AgreementsPage() {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const { data } = await supabase
    .from('agreements')
    .select('id,name,version,created_at')
    .order('created_at', { ascending: false });

  const agreements = (data ?? []) as AgreementRow[];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Agreements</h1>
        <p className="hint">
          Trade secret protection depends on having taken reasonable measures to keep information secret. An NDA with
          everyone who sees it is the usual measure, and its absence is the usual reason a claim fails before anyone
          argues the merits.
        </p>
      </div>

      {agreements.length > 0 && (
        <ul className="space-y-3">
          {agreements.map((agreement) => (
            <li key={agreement.id}>
              <Link
                href={`/dashboard/agreements/${agreement.id}`}
                className="flex items-center justify-between rounded-xl border border-line bg-white px-5 py-4 transition hover:border-ink"
              >
                <div>
                  <p className="font-medium">{agreement.name}</p>
                  <p className="text-sm text-ink-faint">
                    Version <code className="font-mono text-xs">{agreement.version}</code> &middot; created{' '}
                    {new Date(agreement.created_at).toLocaleDateString()}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="card">
        <h2 className="text-base font-semibold">New non-disclosure agreement</h2>
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>This is a template, not legal advice.</strong> Have a lawyer read it before you send it to anyone.
        </div>

        <ActionForm action={createAgreement} className="mt-5 space-y-4">
          <Field name="name" label="Internal name" hint="Just for your own list, e.g. “Contractor NDA”." />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="disclosing_party" label="Your legal entity" />
            <Field name="receiving_party" label="Who will sign" hint="Leave blank for a reusable template." />
            <Field name="disclosing_address" label="Your address" />
            <Field name="contact_email" label="Notice address" type="email" />
            <Field
              name="jurisdiction"
              label="Governing law"
              defaultValue="England and Wales"
              hint="US governing law adds the statutory DTSA immunity notice automatically."
            />
            <Field name="effective_date" label="Effective from" type="date" defaultValue={today} />
            <Field name="purpose" label="Purpose" defaultValue="a contract engineering engagement" />
            <Field name="term_years" label="Confidentiality term (years)" type="number" min={1} max={50} defaultValue={3} />
          </div>

          <div className="space-y-1 border-t border-line pt-4">
            <Toggle name="mutual" label="Both parties will share confidential information" />
            <Toggle
              name="perpetual_trade_secrets"
              label="Protect trade secrets for as long as they stay secret"
              hint="Recommended. A fixed cut-off gives away protection you would otherwise keep."
              defaultChecked
            />
          </div>

          <SubmitButton pendingLabel="Generating…">Create agreement</SubmitButton>
        </ActionForm>
      </div>
    </div>
  );
}
