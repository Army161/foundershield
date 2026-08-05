import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/server';
import { PROJECT_COLUMNS, type Project } from '@/lib/types';
import { StatusPill } from '@/components/status-pill';

const TABS = [
  { href: '', label: 'Overview' },
  { href: '/settings', label: 'Protection' },
  { href: '/routes', label: 'Protected routes' },
  { href: '/events', label: 'Activity' },
  { href: '/evidence', label: 'Evidence' },
];

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const { data } = await supabase.from('projects').select(PROJECT_COLUMNS).eq('id', id).single();
  if (!data) notFound();
  const project = data as Project;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/dashboard" className="text-sm text-ink-faint underline underline-offset-2">
            All domains
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{project.name}</h1>
          <p className="text-sm text-ink-faint">{project.domain}</p>
        </div>
        <StatusPill status={project.status} />
      </div>

      <nav className="flex gap-1 border-b border-line">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={`/dashboard/projects/${id}${tab.href}`}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-ink-soft hover:border-line hover:text-ink"
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {children}
    </div>
  );
}
