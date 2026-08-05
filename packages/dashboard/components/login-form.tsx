'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

type Mode = 'signin' | 'signup';

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);

    const supabase = createSupabaseBrowserClient();

    if (mode === 'signup') {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      setPending(false);
      setMessage(
        error
          ? { kind: 'error', text: error.message }
          : { kind: 'info', text: 'Check your email for a confirmation link.' },
      );
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setPending(false);

    if (error) {
      setMessage({ kind: 'error', text: error.message });
      return;
    }

    // Only same-origin paths are honoured, since `next` comes from the URL.
    const next = searchParams.get('next');
    router.push(next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
    router.refresh();
  }

  return (
    <div className="card">
      <h1 className="text-lg font-semibold tracking-tight">FounderShield</h1>
      <p className="hint">
        {mode === 'signin' ? 'Sign in to manage your protected domains.' : 'Create an account to protect a domain.'}
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        {message && (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={`text-sm ${message.kind === 'error' ? 'text-red-700' : 'text-ink-soft'}`}
          >
            {message.text}
          </p>
        )}

        <button className="btn w-full" type="submit" disabled={pending}>
          {pending ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <button
        type="button"
        className="mt-4 text-sm text-ink-faint underline underline-offset-2"
        onClick={() => {
          setMode(mode === 'signin' ? 'signup' : 'signin');
          setMessage(null);
        }}
      >
        {mode === 'signin' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
      </button>
    </div>
  );
}
