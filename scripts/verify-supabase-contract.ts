/**
 * Contract check between the edge worker and Supabase.
 *
 * The worker talks to Supabase over PostgREST in exactly two places, and both
 * are the kind of seam that unit tests cannot reach: a shape mismatch here
 * shows up as a silently unprotected domain or a silently dropped evidence
 * record, not as a failing test. This drives both against a real local stack.
 *
 *   npx supabase start
 *   npx tsx scripts/verify-supabase-contract.ts
 */

import { normaliseConfig } from '../packages/shared/src/index';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const headers = {
  'content-type': 'application/json',
  apikey: SERVICE_KEY,
  authorization: `Bearer ${SERVICE_KEY}`,
};

let failures = 0;

function check(condition: boolean, label: string): void {
  console.log(`${condition ? 'PASS ' : 'FAIL '} ${label}`);
  if (!condition) failures++;
}

const DOMAIN = 'contract.example.com';

/**
 * Seed a project to point the checks at. Self-contained on purpose: this script
 * has to be runnable straight after `db reset` without anyone remembering to
 * paste SQL first.
 */
async function seed(): Promise<void> {
  const email = 'contract@test.dev';

  // The auth admin API is the only supported way to create a user; the `auth`
  // schema is not exposed through PostgREST.
  const created = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password: 'contract-test-password', email_confirm: true }),
  });

  let userId: string | undefined;
  if (created.ok) {
    userId = ((await created.json()) as { id: string }).id;
  } else {
    // Already present from an earlier run — look it up instead.
    const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, { headers });
    const { users } = (await list.json()) as { users: Array<{ id: string; email: string }> };
    userId = users.find((u) => u.email === email)?.id;
  }

  if (!userId) throw new Error('could not create or find the fixture user');

  await fetch(`${SUPABASE_URL}/rest/v1/projects?domain=eq.${DOMAIN}`, { method: 'DELETE', headers });

  const project = await fetch(`${SUPABASE_URL}/rest/v1/projects`, {
    method: 'POST',
    headers: { ...headers, prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: userId,
      name: 'Contract',
      domain: DOMAIN,
      origin_url: `https://origin.${DOMAIN}`,
      status: 'active',
    }),
  });

  if (!project.ok) throw new Error(`fixture project insert failed: ${await project.text()}`);
  const [{ id }] = (await project.json()) as Array<{ id: string }>;

  const settings = await fetch(`${SUPABASE_URL}/rest/v1/protection_settings?project_id=eq.${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      auth_gate: {
        enabled: true,
        authCookieName: 'session',
        loginPath: '/login',
        routes: [{ id: 'r1', pattern: '/api/**', mode: 'deny', enabled: true }],
      },
    }),
  });

  if (!settings.ok) throw new Error(`fixture settings update failed: ${await settings.text()}`);
}

async function main(): Promise<void> {
  await seed();

  // --- 1. Policy lookup, exactly as config-store.ts performs it -------------

  const configResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/edge_config`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_domain: DOMAIN }),
  });

  check(configResponse.ok, `edge_config RPC responds (${configResponse.status})`);

  const payload: unknown = await configResponse.json();
  const config = normaliseConfig(payload);

  check(config !== null, 'PostgREST output survives normaliseConfig unchanged');

  if (config) {
    check(config.domain === DOMAIN, 'domain round-trips');
    check(config.originUrl === `https://origin.${DOMAIN}`, 'origin round-trips');
    check(config.status === 'active', 'status round-trips as a live project');
    check(config.tpmSecret.length > 0, 'the project secret reaches the worker');
    check(config.tpm.difficulty === 14, 'tpm settings round-trip');
    check(config.rateLimit.requestsPerMinute === 120, 'rate limit settings round-trip');
    check(config.authGate.routes.length === 1, 'protected routes round-trip');
    check(config.authGate.routes[0]?.pattern === '/api/**', 'route pattern round-trips');
    check(config.authGate.routes[0]?.mode === 'deny', 'route mode round-trips');

    // The secret is base64url and must decode to the 32 bytes the HMAC expects.
    check(/^[A-Za-z0-9_-]+=*$/.test(config.tpmSecret), 'secret is url-safe for b64UrlToBytes');
  }

  // An unknown host must be distinguishable from a broken lookup.
  const unknown = await fetch(`${SUPABASE_URL}/rest/v1/rpc/edge_config`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_domain: 'not-a-customer.example.com' }),
  });
  const unknownBody: unknown = await unknown.json();
  check(unknown.ok, 'an unknown domain is a successful lookup, not an error');
  check(normaliseConfig(unknownBody) === null, 'an unknown domain normalises to null');

  // --- 2. Evidence write, exactly as logging.ts performs it -----------------

  const projectId = (config as { projectId: string } | null)?.projectId;

  const row = {
    project_id: projectId,
    occurred_at: new Date().toISOString(),
    ip: '203.0.113.42',
    ip_hash: 'contract-test-hash',
    method: 'GET',
    host: DOMAIN,
    path: '/api/private',
    query: 'page=2',
    user_agent: 'Scrapy/2.11',
    referer: null,
    country: 'GB',
    asn: 12345,
    as_organisation: 'Example Networks',
    tls_version: 'TLSv1.3',
    edge_location: 'LHR',
    request_id: 'contract-ray-id',
    action: 'block',
    enforced: true,
    primary_layer: 'bots',
    reasons: [
      {
        layer: 'bots',
        ruleId: 'ua.scrapy',
        description: 'Request sent by the Scrapy scraping framework',
        action: 'block',
      },
    ],
    bot_score: 90,
    session_id: null,
    response_status: 403,
    decision_ms: 3,
    origin_ms: null,
    response_bytes: 512,
    client_signals: { wd: true },
  };

  const writeResponse = await fetch(`${SUPABASE_URL}/rest/v1/request_events`, {
    method: 'POST',
    headers: { ...headers, prefer: 'return=representation' },
    body: JSON.stringify(row),
  });

  check(writeResponse.ok, `evidence write accepted (${writeResponse.status})`);

  if (writeResponse.ok) {
    const [written] = (await writeResponse.json()) as Array<Record<string, unknown>>;
    check(typeof written?.row_hash === 'string', 'the write trigger hashed the row');
    check(written?.action === 'block', 'the decision was stored');
    check(
      Array.isArray(written?.reasons) && (written.reasons as unknown[]).length === 1,
      'structured reasons survive the round-trip as jsonb',
    );
    check(written?.enforced === true, 'the enforced flag is stored');
  } else {
    console.log(`       ${await writeResponse.text()}`);
  }

  // Every column name in buildEventRow must exist, or PostgREST 400s and every
  // evidence write silently fails in production.
  const badColumn = await fetch(`${SUPABASE_URL}/rest/v1/request_events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...row, no_such_column: 1 }),
  });
  check(!badColumn.ok, 'an unknown column is rejected, so a schema drift cannot pass silently');

  // --- 3. The anon key must not reach any of this ---------------------------

  const anonKey =
    process.env.SUPABASE_ANON_KEY ??
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

  const anonConfig = await fetch(`${SUPABASE_URL}/rest/v1/rpc/edge_config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: anonKey, authorization: `Bearer ${anonKey}` },
    body: JSON.stringify({ p_domain: DOMAIN }),
  });
  check(!anonConfig.ok, `the anon key cannot call edge_config (${anonConfig.status})`);

  const anonEvents = await fetch(`${SUPABASE_URL}/rest/v1/request_events?select=ip`, {
    headers: { apikey: anonKey, authorization: `Bearer ${anonKey}` },
  });
  const anonRows = anonEvents.ok ? ((await anonEvents.json()) as unknown[]) : null;
  check(!anonEvents.ok || (anonRows?.length ?? 0) === 0, 'the anon key reads no evidence');

  console.log(failures === 0 ? '\nALL CONTRACT CHECKS PASSED' : `\n${failures} CONTRACT CHECK(S) FAILED`);
  // Set the code and let the loop drain. Calling process.exit() here aborts
  // libuv mid-teardown on Windows and the real exit status is lost.
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
