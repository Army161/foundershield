import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/server';
import { ActionPill } from '@/components/status-pill';
import type { RequestEvent } from '@/lib/types';

const FILTERS = [
  { value: '', label: 'Everything' },
  { value: 'block', label: 'Blocked' },
  { value: 'challenge', label: 'Challenged' },
  { value: 'allow', label: 'Allowed' },
];

const PAGE_SIZE = 100;

export default async function EventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ action?: string; page?: string }>;
}) {
  const { id } = await params;
  const { action = '', page = '0' } = await searchParams;
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const pageIndex = Math.max(0, Number(page) || 0);

  let query = supabase
    .from('request_events')
    .select('*')
    .eq('project_id', id)
    .order('occurred_at', { ascending: false })
    .range(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE - 1);

  if (action === 'block' || action === 'challenge' || action === 'allow') {
    query = query.eq('action', action);
  }

  const { data } = await query;
  const events = (data ?? []) as RequestEvent[];

  const href = (next: Record<string, string>) => {
    const search = new URLSearchParams({ ...(action ? { action } : {}), ...next });
    const suffix = search.toString();
    return `/dashboard/projects/${id}/events${suffix ? `?${suffix}` : ''}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((filter) => (
          <Link
            key={filter.value}
            href={
              filter.value
                ? `/dashboard/projects/${id}/events?action=${filter.value}`
                : `/dashboard/projects/${id}/events`
            }
            className={`rounded-lg border px-3 py-1.5 text-sm ${
              action === filter.value ? 'border-ink bg-ink text-white' : 'border-line bg-white text-ink-soft'
            }`}
          >
            {filter.label}
          </Link>
        ))}
      </div>

      {events.length === 0 ? (
        <div className="card text-sm text-ink-faint">
          No activity recorded yet. Once DNS is pointed at the proxy and traffic arrives, blocked and challenged
          requests appear here immediately.
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Result</th>
                <th className="px-4 py-3 font-medium">Address</th>
                <th className="px-4 py-3 font-medium">Request</th>
                <th className="px-4 py-3 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} className="border-b border-line/60 align-top">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-faint">
                    {new Date(event.occurred_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <ActionPill action={event.action} enforced={event.enforced} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs">{event.ip ?? '—'}</span>
                    {event.country && <span className="ml-2 text-xs text-ink-faint">{event.country}</span>}
                    {event.as_organisation && (
                      <span className="block text-xs text-ink-faint">{event.as_organisation}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs">
                      {event.method} {event.path}
                    </span>
                    <span className="block max-w-md truncate text-xs text-ink-faint" title={event.user_agent}>
                      {event.user_agent || '(no user-agent)'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-soft">
                    {event.reasons.length === 0
                      ? '—'
                      : event.reasons.map((reason, index) => (
                          <span key={`${event.id}-${index}`} className="block">
                            {reason.description}
                          </span>
                        ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between">
        {pageIndex > 0 ? (
          <Link href={href({ page: String(pageIndex - 1) })} className="btn-secondary">
            Previous
          </Link>
        ) : (
          <span />
        )}
        {events.length === PAGE_SIZE && (
          <Link href={href({ page: String(pageIndex + 1) })} className="btn-secondary">
            Next
          </Link>
        )}
      </div>
    </div>
  );
}
