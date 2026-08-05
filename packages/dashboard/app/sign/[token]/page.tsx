import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { SubmitButton } from '@/components/form';

export const metadata = { title: 'Sign agreement' };

interface SignatureView {
  signatureId: string;
  status: 'pending' | 'viewed' | 'signed' | 'declined' | 'revoked';
  signerName: string;
  signerEmail: string;
  signedAt: string | null;
  typedName: string | null;
  agreementName: string;
  version: string;
  body: string;
}

/**
 * The signer is not a FounderShield user and never becomes one. The link is the
 * only capability: it is looked up through a SECURITY DEFINER function that
 * takes the token, so holding it grants exactly one thing — the ability to read
 * and sign this one agreement.
 */
async function loadSignature(token: string): Promise<SignatureView | null> {
  const service = createSupabaseServiceClient();
  const { data } = await service.rpc('signature_view', { p_token: token });
  return (data as SignatureView | null) ?? null;
}

async function sign(formData: FormData): Promise<void> {
  'use server';

  const token = String(formData.get('token') ?? '');
  const typedName = String(formData.get('typed_name') ?? '');

  const headerList = await headers();
  const ip =
    headerList.get('cf-connecting-ip') ??
    headerList.get('x-real-ip') ??
    (headerList.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ??
    '';

  const service = createSupabaseServiceClient();
  await service.rpc('signature_sign', {
    p_token: token,
    p_typed_name: typedName,
    p_ip: ip,
    p_user_agent: headerList.get('user-agent') ?? '',
  });

  revalidatePath(`/sign/${token}`);
}

async function decline(formData: FormData): Promise<void> {
  'use server';

  const token = String(formData.get('token') ?? '');
  const service = createSupabaseServiceClient();
  await service.rpc('signature_decline', { p_token: token });
  revalidatePath(`/sign/${token}`);
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="card">{children}</div>
      <p className="mt-4 text-center text-xs text-ink-faint">Protected by FounderShield</p>
    </main>
  );
}

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const signature = await loadSignature(token);

  if (!signature) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">This link is not valid</h1>
        <p className="hint">
          It may have been mistyped, or withdrawn by whoever sent it. Ask them for a new one.
        </p>
      </Shell>
    );
  }

  if (signature.status === 'signed') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">Already signed</h1>
        <p className="hint">
          {signature.agreementName} was signed as &ldquo;{signature.typedName}&rdquo;
          {signature.signedAt && ` on ${new Date(signature.signedAt).toLocaleString()}`}. Keep a copy of the text below
          for your records.
        </p>
        <pre className="mt-5 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-4 font-mono text-xs leading-relaxed">
          {signature.body}
        </pre>
      </Shell>
    );
  }

  if (signature.status === 'declined' || signature.status === 'revoked') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">
          {signature.status === 'declined' ? 'You declined this agreement' : 'This link has been withdrawn'}
        </h1>
        <p className="hint">Contact whoever sent it if you think this is a mistake.</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-lg font-semibold">{signature.agreementName}</h1>
      <p className="hint">
        Sent to {signature.signerName} ({signature.signerEmail}). Read it in full before you sign. Version{' '}
        <code className="font-mono text-xs">{signature.version}</code>.
      </p>

      <pre className="mt-5 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-4 font-mono text-xs leading-relaxed">
        {signature.body}
      </pre>

      <form action={sign} className="mt-6 space-y-3">
        <input type="hidden" name="token" value={token} />
        <label className="label" htmlFor="typed_name">
          Type your full name to sign
        </label>
        <input id="typed_name" name="typed_name" className="input" required autoComplete="name" />
        <p className="text-sm text-ink-faint">
          Signing records your name, the time, your network address, and a hash of the exact text above, so it is clear
          later what you agreed to.
        </p>
        <SubmitButton pendingLabel="Signing…">Sign agreement</SubmitButton>
      </form>

      <form action={decline} className="mt-4 border-t border-line pt-4">
        <input type="hidden" name="token" value={token} />
        <button type="submit" className="text-sm text-ink-faint underline underline-offset-2">
          I do not agree
        </button>
      </form>
    </Shell>
  );
}
