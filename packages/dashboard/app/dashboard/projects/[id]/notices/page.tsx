import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/server';
import { deleteNotice, draftDemand, draftDmca, markNoticeSent } from '@/lib/agreements';
import { ActionForm, Field, SubmitButton, TextArea, Toggle } from '@/components/form';
import { PROJECT_COLUMNS, type ActorBurden, type Project } from '@/lib/types';

interface Notice {
  id: string;
  kind: 'dmca-512' | 'circumvention' | 'access';
  addressee: string;
  subject: string;
  body: string;
  cautions: string[];
  marked_sent_at: string | null;
  created_at: string;
}

const KIND_LABEL: Record<Notice['kind'], string> = {
  'dmca-512': 'DMCA §512 takedown',
  circumvention: 'Circumvention demand',
  access: 'Access / terms demand',
};

const DAYS = 30;

export default async function NoticesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const until = new Date();
  const since = new Date(until.getTime() - DAYS * 24 * 60 * 60 * 1000);

  const [{ data: projectRow }, { data: burdenRows }, { data: noticeRows }] = await Promise.all([
    supabase.from('projects').select(PROJECT_COLUMNS).eq('id', id).single(),
    supabase.rpc('actor_burden', {
      p_project_id: id,
      p_since: since.toISOString(),
      p_until: until.toISOString(),
    }),
    supabase
      .from('notices')
      .select('id,kind,addressee,subject,body,cautions,marked_sent_at,created_at')
      .eq('project_id', id)
      .order('created_at', { ascending: false }),
  ]);

  if (!projectRow) notFound();
  const project = projectRow as Project;
  const actors = ((burdenRows ?? []) as ActorBurden[]).filter((a) => a.blocked + a.challenged > 0);
  const notices = (noticeRows ?? []) as Notice[];

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="text-base font-semibold">What these are for</h2>
        <div className="mt-2 space-y-2 text-sm text-ink-soft">
          <p>
            FounderShield drafts. It does not send, and it will not sign anything on your behalf. Every draft below is
            a starting point for a conversation with a lawyer, not a finished document.
          </p>
          <p>
            The two kinds rest on different facts and go to different people. A <strong>DMCA §512 takedown</strong> goes
            to a <em>host</em>, about your content republished on their system — your access logs are not evidence of
            that, so it is built from what you tell it. A <strong>demand</strong> goes to whoever ran the traffic, and
            is built from what the proxy actually recorded.
          </p>
        </div>
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">Demand, from recorded activity</h2>
        <p className="hint">
          Addresses stopped by an access control in the last {DAYS} days. Pick the ones you want the letter to describe.
        </p>

        {actors.length === 0 ? (
          <p className="mt-4 text-sm text-ink-faint">
            Nothing has been stopped in this period, so there is nothing to write about.
          </p>
        ) : (
          <ActionForm action={draftDemand} className="mt-4 space-y-4">
            <input type="hidden" name="project_id" value={id} />
            <input type="hidden" name="days" value={DAYS} />

            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
              {actors.map((actor) => (
                <label key={actor.ip} className="flex items-start gap-3 rounded-md p-2 hover:bg-surface">
                  <input type="checkbox" name="actor" value={actor.ip} className="mt-1 h-4 w-4 accent-ink" />
                  <span className="text-sm">
                    <span className="font-mono text-xs">{actor.ip}</span>
                    {actor.as_organisation && <span className="ml-2 text-ink-faint">{actor.as_organisation}</span>}
                    <span className="block text-xs text-ink-faint">
                      {actor.requests.toLocaleString()} requests, {actor.blocked.toLocaleString()} refused, peak{' '}
                      {actor.peak_requests_per_minute}/min
                      {(actor.rule_ids ?? []).length > 0 && ` · ${(actor.rule_ids ?? []).join(', ')}`}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            <div>
              <p className="label">Which letter</p>
              <div className="mt-2 space-y-2">
                <label className="flex items-start gap-3 rounded-lg border border-line p-3">
                  <input type="radio" name="kind" value="access" defaultChecked className="mt-1 h-4 w-4 accent-ink" />
                  <span>
                    <span className="text-sm font-medium">Access and terms</span>
                    <span className="block text-sm text-ink-faint">
                      Rests on your terms of use and any gated routes that were touched. The right default.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 rounded-lg border border-line p-3">
                  <input type="radio" name="kind" value="circumvention" className="mt-1 h-4 w-4 accent-ink" />
                  <span>
                    <span className="text-sm font-medium">Circumvention of access controls</span>
                    <span className="block text-sm text-ink-faint">
                      Only worth sending where a token was forged or lifted. The draft says so if the records do not
                      show that.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="sender_name" label="Your name" />
              <Field name="sender_entity" label="Your entity" defaultValue={project.name} />
              <Field name="sender_email" label="Reply address" type="email" />
              <Field name="recipient" label="Who you are writing to" hint="e.g. the host’s abuse team." />
            </div>

            <SubmitButton pendingLabel="Drafting…">Draft demand</SubmitButton>
          </ActionForm>
        )}
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">DMCA §512 takedown</h2>
        <p className="hint">
          For content of yours republished somewhere else. Every field is required: an incomplete notice does not oblige
          the host to do anything, so this form will refuse to draft one.
        </p>

        <ActionForm action={draftDmca} className="mt-4 space-y-4">
          <input type="hidden" name="project_id" value={id} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="signatory_name" label="Your full name" />
            <Field name="signatory_title" label="Your title" />
            <Field name="signatory_email" label="Email" type="email" />
            <Field name="signatory_phone" label="Telephone" />
            <Field name="signatory_address" label="Postal address" />
            <Field name="rights_holder" label="Rights holder" hint="Leave blank if that is you personally." />
            <Field name="service_provider" label="Host you are notifying" />
          </div>

          <TextArea name="work_description" label="What was copied" rows={3} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextArea name="original_urls" label="Where your original lives" rows={3} hint="One URL per line." />
            <TextArea name="infringing_urls" label="Where the copy is" rows={3} hint="One URL per line." />
          </div>

          <div className="space-y-1 border-t border-line pt-4">
            <p className="text-sm text-ink-soft">
              The next three are sworn statements. Read them — the second and third are made under penalty of perjury,
              and 17 U.S.C. §512(f) creates liability for knowingly misrepresenting that material is infringing.
              FounderShield will not tick these for you.
            </p>
            <Toggle
              name="good_faith"
              label="I have a good faith belief this use is not authorised by the rights holder, its agent, or the law"
              hint="This includes having considered whether it might be fair use."
            />
            <Toggle name="accuracy" label="I swear, under penalty of perjury, that this information is accurate" />
            <Toggle
              name="authority"
              label="I swear, under penalty of perjury, that I am the rights holder or authorised to act for them"
            />
          </div>

          <SubmitButton pendingLabel="Checking…">Draft takedown notice</SubmitButton>
        </ActionForm>
      </section>

      {notices.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-base font-semibold">Drafts</h2>
          {notices.map((notice) => (
            <article key={notice.id} className="card">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="font-medium">{KIND_LABEL[notice.kind]}</p>
                  <p className="text-sm text-ink-faint">
                    To {notice.addressee} &middot; drafted {new Date(notice.created_at).toLocaleDateString()}
                    {notice.marked_sent_at && ` · you marked it sent ${new Date(notice.marked_sent_at).toLocaleDateString()}`}
                  </p>
                </div>
              </div>

              {notice.cautions.length > 0 && (
                <ul className="mt-3 list-disc space-y-1 rounded-lg bg-amber-50 py-2 pl-8 pr-3 text-sm text-amber-900">
                  {notice.cautions.map((caution, index) => (
                    <li key={index}>{caution}</li>
                  ))}
                </ul>
              )}

              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-4 font-mono text-xs leading-relaxed">
                {notice.body}
              </pre>

              <div className="mt-3 flex flex-wrap gap-3">
                {!notice.marked_sent_at && (
                  <form action={markNoticeSent}>
                    <input type="hidden" name="project_id" value={id} />
                    <input type="hidden" name="notice_id" value={notice.id} />
                    <button type="submit" className="btn-secondary">
                      I sent this
                    </button>
                  </form>
                )}
                <form action={deleteNotice}>
                  <input type="hidden" name="project_id" value={id} />
                  <input type="hidden" name="notice_id" value={notice.id} />
                  <button type="submit" className="btn-danger">
                    Delete draft
                  </button>
                </form>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
