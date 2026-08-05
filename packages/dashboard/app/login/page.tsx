import { Suspense } from 'react';
import { LoginForm } from '@/components/login-form';

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      {/* LoginForm reads `next` from the query string, which needs a boundary. */}
      <Suspense fallback={<div className="card text-sm text-ink-faint">Loading…</div>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
