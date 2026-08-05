import type { ProjectStatus } from '@foundershield/shared';

const STYLES: Record<ProjectStatus, { className: string; label: string }> = {
  active: { className: 'bg-emerald-50 text-emerald-800', label: 'Protected' },
  pending: { className: 'bg-amber-50 text-amber-800', label: 'Setup incomplete' },
  paused: { className: 'bg-neutral-100 text-neutral-700', label: 'Paused' },
};

export function StatusPill({ status }: { status: ProjectStatus }) {
  const style = STYLES[status] ?? STYLES.pending;
  return <span className={`pill ${style.className}`}>{style.label}</span>;
}

const ACTION_STYLES: Record<string, string> = {
  block: 'bg-red-50 text-red-800',
  challenge: 'bg-amber-50 text-amber-800',
  allow: 'bg-neutral-100 text-neutral-700',
};

export function ActionPill({ action, enforced }: { action: string; enforced: boolean }) {
  return (
    <span className={`pill ${ACTION_STYLES[action] ?? ACTION_STYLES.allow}`}>
      {action}
      {!enforced && action !== 'allow' && ' (monitored)'}
    </span>
  );
}
