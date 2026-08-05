'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult } from '@/lib/actions';

const EMPTY: ActionResult = { ok: false };

export function SubmitButton({
  children,
  className = 'btn',
  pendingLabel = 'Saving…',
}: {
  children: React.ReactNode;
  className?: string;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}

/**
 * Wraps a server action and renders its result inline. Keeping this in one
 * place means every form in the dashboard reports success and failure the same
 * way, including the ones that call out to DNS and the edge.
 */
export function ActionForm({
  action,
  children,
  className,
}: {
  action: (state: ActionResult, formData: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, EMPTY);

  return (
    <form action={formAction} className={className}>
      {children}
      {state.error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.error}
        </p>
      )}
      {state.ok && state.message && (
        <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {state.message}
        </p>
      )}
    </form>
  );
}

export function Toggle({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 py-2">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-1 h-4 w-4 accent-ink" />
      <span>
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="block text-sm text-ink-faint">{hint}</span>}
      </span>
    </label>
  );
}

export function Field({
  name,
  label,
  hint,
  type = 'text',
  defaultValue,
  min,
  max,
  step,
}: {
  name: string;
  label: string;
  hint?: string;
  type?: string;
  defaultValue?: string | number;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div>
      <label className="label" htmlFor={name}>
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        className="input"
        defaultValue={defaultValue}
        min={min}
        max={max}
        step={step}
      />
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function TextArea({
  name,
  label,
  hint,
  defaultValue,
  rows = 4,
  placeholder,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: string;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="label" htmlFor={name}>
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        rows={rows}
        placeholder={placeholder}
        className="input font-mono text-xs"
        defaultValue={defaultValue}
      />
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
