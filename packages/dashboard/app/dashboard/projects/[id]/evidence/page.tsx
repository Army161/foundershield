import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/server';
import { sealEvidence } from '@/lib/actions';
import { ActionForm, SubmitButton } from '@/components/form';

interface Seal {
  id: string;
  from_event: number;
  to_event: number;
  event_count: number;
  digest: string;
  sealed_at: string;
}

export default async function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const { data } = await supabase
    .from('evidence_seals')
    .select('id,from_event,to_event,event_count,digest,sealed_at')
    .eq('project_id', id)
    .order('sealed_at', { ascending: false })
    .limit(50);

  const seals = (data ?? []) as Seal[];

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="text-base font-semibold">Export</h2>
        <p className="hint">
          A CSV of every recorded request, with the observed facts and the reason each decision was taken. Each row
          carries the hash computed when it was written.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <a className="btn-secondary" href={`/api/projects/${id}/export?format=csv`}>
            Download CSV
          </a>
          <a className="btn-secondary" href={`/api/projects/${id}/export?format=json`}>
            Download JSON
          </a>
        </div>
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">Seals</h2>
        <p className="hint">
          Sealing fixes the contents of every event recorded since the last seal. Each seal chains to the one before it,
          so a later edit, insertion or deletion anywhere in a sealed range changes the digest and is detectable. Seal
          regularly — a seal created before a dispute is worth considerably more than one created after it.
        </p>

        <ActionForm action={sealEvidence} className="mt-4">
          <input type="hidden" name="project_id" value={id} />
          <SubmitButton pendingLabel="Sealing…">Seal events up to now</SubmitButton>
        </ActionForm>

        {seals.length > 0 && (
          <table className="mt-6 w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th className="pb-2 font-medium">Sealed</th>
                <th className="pb-2 font-medium">Events</th>
                <th className="pb-2 font-medium">Digest</th>
              </tr>
            </thead>
            <tbody>
              {seals.map((seal) => (
                <tr key={seal.id} className="border-t border-line">
                  <td className="py-2 text-ink-faint">{new Date(seal.sealed_at).toLocaleString()}</td>
                  <td className="py-2 tabular-nums">{seal.event_count}</td>
                  <td className="py-2 font-mono text-xs break-all">{seal.digest}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card bg-surface">
        <h2 className="text-base font-semibold">What this is, and what it is not</h2>
        <div className="mt-2 space-y-2 text-sm text-ink-soft">
          <p>
            These records are a contemporaneous, tamper-evident log of what your server observed: who connected, what
            they asked for, what the access controls did, and when. That is genuinely useful — it is the kind of
            record that is hard to assemble after the fact.
          </p>
          <p>
            It is not a legal conclusion. Whether a particular pattern of access breaches your terms, or gives rise to a
            claim under any statute, depends on facts and law well beyond what a proxy can see. Take the export to a
            lawyer; do not treat the dashboard as one.
          </p>
        </div>
      </section>
    </div>
  );
}
