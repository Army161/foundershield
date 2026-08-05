/**
 * Talking to the edge deployment from the dashboard.
 *
 * Two jobs: invalidating the policy cache after a settings change, and proving
 * that a customer's traffic actually reaches us before we call a domain live.
 */

export interface DnsCheckResult {
  ok: boolean;
  found: string[];
  error?: string;
}

/**
 * DNS-over-HTTPS TXT lookup against Cloudflare's resolver.
 *
 * Deliberately not Node's `dns` module: this has to work unchanged on Vercel's
 * edge runtime, and a resolver we name explicitly is easier to reason about
 * than whatever the host's resolv.conf happens to say.
 */
export async function lookupTxt(name: string): Promise<DnsCheckResult> {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
      { headers: { accept: 'application/dns-json' }, cache: 'no-store' },
    );
    if (!response.ok) return { ok: false, found: [], error: `resolver returned ${response.status}` };

    const payload = (await response.json()) as { Answer?: Array<{ data: string }> };
    const found = (payload.Answer ?? []).map((answer) => answer.data.replace(/^"|"$/g, ''));
    return { ok: true, found };
  } catch (error) {
    return { ok: false, found: [], error: error instanceof Error ? error.message : 'lookup failed' };
  }
}

export interface ProxyCheckResult {
  ok: boolean;
  status: number | null;
  project: string | null;
  error?: string;
}

/**
 * Confirms the domain resolves to *our* proxy by requesting the health endpoint
 * and checking it reports the project we expect. A CNAME pointing somewhere
 * else, or a stale cached record, fails here rather than silently leaving the
 * customer unprotected.
 */
export async function checkProxyReachable(domain: string, expectedProjectId: string): Promise<ProxyCheckResult> {
  try {
    const response = await fetch(`https://${domain}/__fs/v1/health`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      redirect: 'manual',
    });

    if (!response.ok) return { ok: false, status: response.status, project: null };

    const payload = (await response.json()) as { project?: string | null };
    return {
      ok: payload.project === expectedProjectId,
      status: response.status,
      project: payload.project ?? null,
    };
  } catch (error) {
    return { ok: false, status: null, project: null, error: error instanceof Error ? error.message : 'unreachable' };
  }
}

/**
 * Drop the cached policy at the edge so a settings change takes effect now
 * rather than at the end of the cache TTL. Best-effort: the TTL is the
 * correctness guarantee, this is only the latency improvement.
 */
export async function purgeEdgeConfig(domain: string): Promise<void> {
  const base = process.env.FS_EDGE_BASE_URL;
  const key = process.env.FS_ADMIN_KEY;
  if (!base || !key) return;

  try {
    await fetch(`${base}/__fs/v1/admin/purge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fs-admin-key': key },
      body: JSON.stringify({ domain }),
      cache: 'no-store',
    });
  } catch (error) {
    console.error('edge cache purge failed', error);
  }
}

export function edgeHostname(): string {
  return process.env.NEXT_PUBLIC_FS_EDGE_HOSTNAME ?? 'proxy.foundershield.dev';
}
