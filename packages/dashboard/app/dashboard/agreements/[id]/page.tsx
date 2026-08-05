import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { reviewNda, type NdaInput } from '@foundershield/shared';
import { createSupabaseServiceClient, requireUser } from '@/lib/supabase/server';
import { deleteAgreement, issueSignatureRequest, revokeSignatureRequest } from '@/lib/agreements';
import { ActionForm, Field, SubmitButton } from '@/components/form';

interface Agreement {
  id: string;
  name: string;
  version: string;
  input: NdaInput;
  body: string;
  created_at: string;
}

interface Signature {
  id: string;
  signer_name: string;
  signer_email: string;
  status: 'pending' | 'viewed' | 'signed' | 'declined' | 'revoked';
  signed_version: string;
  sent_at: string;
  viewed_at: string | null;
  signed_at: string | null;
  typed_name: string | null;
  signature_ip: string | null;
  body_hash: string | null;
}

const STATUS_STYLE: Record<Signature['status'], string> = {
  pending: 'bg-neutral-100 text-neutral-700',
  viewed: 'bg-amber-50 text-amber-800',
  signed: 'bg-emerald-50 text-emerald-800',
  declined: 'bg-red-50 text-red-800',
  revoked: 'bg-neutral-100 text-neutral-500',
};

export default async function AgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const [{ data: agreementRow }, { data: signatureRows }] = await Promise.all([
    supabase.from('agreements').select('id,name,version,input,body,created_at').eq('id', id).single(),
    supabase
      .from('agreement_signatures')
      .select('id,signer_name,signer_email,status,signed_version,sent_at,viewed_at,signed_at,typed_name,signature_ip,body_hash')
      .eq('agreement_id', id)
      .order('created_at', { ascending: false }),
  ]);

  if (!agreementRow) notFound();
  const agreement = agreementRow as Agreement;
  const signatures = (signatureRows ?? []) as Signature[];

  // The signing token has no column grant for the browser client, so links are
  // resolved here with the service role — after RLS has already established
  // that these signatures belong to the caller.
  const links = new Map<string, string>();
  const outstanding = signatures.filter((s) => s.status === 'pending' || s.status === 'viewed');
  if (outstanding.length > 0) {
    const service = createSupabaseServiceClient();
    const { data: tokenRows } = await service
      .from('agreement_signatures')
      .select('id,access_token')
      .in(
        'id',
        outstanding.map((s) => s.id),
      );
    const base = process.env.NEXT_PUBLIC_APP_URL ?? '';
    for (const row of (tokenRows ?? []) as Array<{ id: string; access_token: string }>) {
      links.set(row.id, `${base}/sign/${row.access_token}`);
    }
  }

  const warnings = reviewNda(agreement.input);
  const signedCount = signatures.filter((s) => s.status === 'signed').length;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/agreements" className="text-sm text-ink-faint underline underline-offset-2">
          All agreements
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{agreement.name}</h1>
        <p className="text-sm text-ink-faint">
          Version <code className="font-mono text-xs">{agreement.version}</code>
          {signedCount > 0 && ` · signed by ${signedCount}`}
        </p>
      </div>

      {warnings.length > 0 && (
        <section className="card border-amber-200 bg-amber-50/40">
          <h2 className="text-base font-semibold">Worth a look</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-ink-soft">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      )}

      {signedCount > 0 && (
        <p className="rounded-lg bg-surface px-3 py-2 text-sm text-ink-soft">
          This agreement has been signed, so its text is now frozen. To change the wording, create a new agreement —
          altering this one would leave the signature recording a document that no longer exists.
        </p>
      )}

      <section className="card">
        <h2 className="text-base font-semibold">Send for signature</h2>
        <p className="hint">
          FounderShield creates the link. Sending it is up to you — we do not email anyone on your behalf.
        </p>
        <ActionForm action={issueSignatureRequest} className="mt-4 space-y-4">
          <input type="hidden" name="agreement_id" value={agreement.id} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="signer_name" label="Signer’s name" />
            <Field name="signer_email" label="Signer’s email" type="email" />
          </div>
          <SubmitButton>Create signing link</SubmitButton>
        </ActionForm>
      </section>

      {signatures.length > 0 && (
        <section className="card overflow-x-auto">
          <h2 className="text-base font-semibold">Signatures</h2>
          <table className="mt-3 w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th className="pb-2 font-medium">Signer</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Record</th>
                <th className="pb-2 font-medium">Link</th>
              </tr>
            </thead>
            <tbody>
              {signatures.map((signature) => (
                <tr key={signature.id} className="border-t border-line align-top">
                  <td className="py-3">
                    <span className="font-medium">{signature.signer_name}</span>
                    <span className="block text-xs text-ink-faint">{signature.signer_email}</span>
                  </td>
                  <td className="py-3">
                    <span className={`pill ${STATUS_STYLE[signature.status]}`}>{signature.status}</span>
                  </td>
                  <td className="py-3 text-xs text-ink-faint">
                    {signature.status === 'signed' ? (
                      <>
                        Signed as &ldquo;{signature.typed_name}&rdquo;
                        <br />
                        {signature.signed_at && new Date(signature.signed_at).toLocaleString()}
                        {signature.signature_ip && <> from {signature.signature_ip}</>}
                        <br />
                        <span className="font-mono">{signature.body_hash?.slice(0, 24)}…</span>
                      </>
                    ) : signature.viewed_at ? (
                      <>Opened {new Date(signature.viewed_at).toLocaleString()}</>
                    ) : (
                      <>Sent {new Date(signature.sent_at).toLocaleDateString()}</>
                    )}
                  </td>
                  <td className="py-3">
                    {links.has(signature.id) ? (
                      <div className="space-y-1">
                        <input
                          readOnly
                          value={links.get(signature.id)}
                          className="w-full min-w-[16rem] rounded border border-line bg-surface px-2 py-1 font-mono text-[11px]"
                        />
                        <form action={revokeSignatureRequest}>
                          <input type="hidden" name="signature_id" value={signature.id} />
                          <input type="hidden" name="agreement_id" value={agreement.id} />
                          <button type="submit" className="text-xs text-ink-faint underline underline-offset-2">
                            Revoke
                          </button>
                        </form>
                      </div>
                    ) : (
                      <span className="text-xs text-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2 className="text-base font-semibold">Document</h2>
        <pre className="mt-3 max-h-[36rem] overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-4 font-mono text-xs leading-relaxed">
          {agreement.body}
        </pre>
      </section>

      <section className="card border-red-200">
        <h2 className="text-base font-semibold">Delete</h2>
        <p className="hint">
          Removes the agreement and every signature record attached to it, including completed ones. If any of these
          have been signed, export them first — this cannot be undone.
        </p>
        <form action={deleteAgreement} className="mt-4">
          <input type="hidden" name="agreement_id" value={agreement.id} />
          <button type="submit" className="btn-danger">
            Delete agreement
          </button>
        </form>
      </section>
    </div>
  );
}
