// Hard build-time guard: importing this module from a Client Component is an
// error, not a silent bundle of the service-role key. The `next/headers` import
// below happens to enforce this too, but only as a side effect of import order
// and tree-shaking — this states it outright.
import 'server-only';

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

type CookiesToSet = Array<{ name: string; value: string; options: CookieOptions }>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/** Request-scoped client. Every query runs as the signed-in user, under RLS. */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // The middleware refreshes the session, so this is safe to ignore.
          }
        },
      },
    },
  );
}

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Only three things legitimately need it, and each is a fact the customer must
 * not be able to assert about themselves:
 *   - reading `tpm_secret`
 *   - marking a domain as DNS-verified
 *   - flipping a project to `active`
 *
 * Never construct this in a path that takes user-supplied ids without first
 * checking ownership against the request-scoped client.
 */
export function createSupabaseServiceClient() {
  return createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}
