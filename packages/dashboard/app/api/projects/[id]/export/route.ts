import { NextResponse, type NextRequest } from 'next/server';
import { requireUser } from '@/lib/supabase/server';
import type { RequestEvent } from '@/lib/types';

const MAX_ROWS = 50_000;

const COLUMNS: Array<keyof RequestEvent | 'why'> = [
  'occurred_at',
  'ip',
  'country',
  'as_organisation',
  'method',
  'host',
  'path',
  'query',
  'user_agent',
  'referer',
  'action',
  'enforced',
  'primary_layer',
  'bot_score',
  'response_status',
  'edge_location',
  'request_id',
  'why',
  'row_hash',
];

/** RFC 4180 quoting, plus a guard against spreadsheet formula injection. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { supabase, user } = await requireUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // RLS already scopes this to projects the caller owns; an id they do not own
  // simply returns nothing.
  const { data, error } = await supabase
    .from('request_events')
    .select('*')
    .eq('project_id', id)
    .order('occurred_at', { ascending: true })
    .limit(MAX_ROWS);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const events = (data ?? []) as RequestEvent[];
  const format = request.nextUrl.searchParams.get('format') ?? 'csv';
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    return new NextResponse(JSON.stringify({ projectId: id, exportedAt: new Date().toISOString(), events }, null, 2), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="foundershield-${id}-${stamp}.json"`,
      },
    });
  }

  const rows = [COLUMNS.join(',')];
  for (const event of events) {
    rows.push(
      COLUMNS.map((column) =>
        column === 'why'
          ? csvCell(event.reasons.map((reason) => reason.description).join(' | '))
          : csvCell(event[column as keyof RequestEvent]),
      ).join(','),
    );
  }

  return new NextResponse(rows.join('\r\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="foundershield-${id}-${stamp}.csv"`,
    },
  });
}
