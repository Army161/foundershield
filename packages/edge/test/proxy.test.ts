import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { isValidProofOfWork } from '@foundershield/shared';
import { ORIGIN_HTML } from './fixtures.js';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Headers a real Chrome sends on a top-level navigation. */
function documentHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'user-agent': CHROME,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-GB,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-dest': 'document',
    ...extra,
  };
}

/** Headers a real Chrome sends on a `fetch()` from page script. */
function xhrHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'user-agent': CHROME,
    accept: 'application/json',
    'accept-language': 'en-GB,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-dest': 'empty',
    ...extra,
  };
}

function cookieFrom(response: Response, name: string): string | null {
  const header = response.headers.get('set-cookie');
  if (!header) return null;
  const match = new RegExp(`${name}=([^;]+)`).exec(header);
  return match?.[1] ?? null;
}

/** Drive the same challenge/verify exchange the browser script performs. */
async function obtainToken(host: string, headers: Record<string, string>): Promise<string> {
  const challengeResponse = await SELF.fetch(`https://${host}/__fs/v1/challenge`, { headers });
  expect(challengeResponse.status).toBe(200);
  const challenge = (await challengeResponse.json()) as { cid: string; salt: string; difficulty: number };

  let nonce = '';
  for (let i = 0; i < 1_000_000; i++) {
    if (await isValidProofOfWork(challenge.salt, String(i), challenge.difficulty)) {
      nonce = String(i);
      break;
    }
  }
  expect(nonce).not.toBe('');

  const verifyResponse = await SELF.fetch(`https://${host}/__fs/v1/verify`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ cid: challenge.cid, nonce, signals: { wd: false, hc: 8 } }),
  });
  expect(verifyResponse.status).toBe(200);

  const token = cookieFrom(verifyResponse, '__fs_tk');
  expect(token).toBeTruthy();
  return token as string;
}

describe('routing and health', () => {
  it('refuses to proxy a hostname that is not configured', async () => {
    const response = await SELF.fetch('https://unknown.example.com/', { headers: documentHeaders() });
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe('domain_not_configured');
  });

  it('reports health, which is what DNS verification checks', async () => {
    const response = await SELF.fetch('https://standard.example.com/__fs/v1/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-foundershield')).toBe('active');
    expect(await response.json()).toMatchObject({ ok: true, project: 'p-standard', mode: 'standard' });
  });

  it('serves the challenge client from the reserved prefix', async () => {
    const response = await SELF.fetch('https://standard.example.com/__fs/v1/c.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(await response.text()).toContain('__foundershield');
  });

  it('never forwards the reserved prefix to the origin', async () => {
    const response = await SELF.fetch('https://standard.example.com/__fs/v1/nope');
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('protected work');
  });

  it('proxies without enforcing while a project is paused', async () => {
    const response = await SELF.fetch('https://paused.example.com/', { headers: documentHeaders() });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('protected work');
  });
});

describe('standard mode', () => {
  it('serves the HTML document and injects the challenge into it', async () => {
    const response = await SELF.fetch('https://standard.example.com/', { headers: documentHeaders() });
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('protected work');
    expect(body).toContain('/__fs/v1/c.js');
  });

  it('withholds non-document responses until the challenge is solved', async () => {
    const response = await SELF.fetch('https://standard.example.com/json', { headers: xhrHeaders() });
    expect(response.status).toBe(403);
    expect(response.headers.get('x-fs-challenge')).toBe('required');
    expect(await response.text()).not.toContain('protected');
  });

  it('serves the same resource once a valid token is presented', async () => {
    const headers = xhrHeaders();
    const token = await obtainToken('standard.example.com', headers);

    const response = await SELF.fetch('https://standard.example.com/json', {
      headers: { ...headers, cookie: `__fs_tk=${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: 'protected' });
  });

  it('blocks a forged token rather than merely re-challenging it', async () => {
    const headers = xhrHeaders();
    const token = await obtainToken('standard.example.com', headers);
    const [prefix, payload] = token.split('.') as [string, string, string];

    const response = await SELF.fetch('https://standard.example.com/json', {
      headers: { ...headers, cookie: `__fs_tk=${prefix}.${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('x-fs-challenge')).toBeNull();
  });

  it('rejects a token lifted into a different browser', async () => {
    const token = await obtainToken('standard.example.com', xhrHeaders());

    const response = await SELF.fetch('https://standard.example.com/json', {
      headers: { ...xhrHeaders({ 'user-agent': 'python-requests/2.32.3' }), cookie: `__fs_tk=${token}` },
    });
    expect(response.status).toBe(403);
  });

  it('leaves exempt paths alone', async () => {
    const response = await SELF.fetch('https://standard.example.com/.well-known/acme-challenge/abc', {
      headers: xhrHeaders(),
    });
    expect(response.status).toBe(200);
  });

  it('strips proxy cookies before they reach the origin', async () => {
    const headers = xhrHeaders();
    const token = await obtainToken('standard.example.com', headers);

    const response = await SELF.fetch('https://standard.example.com/echo-headers', {
      headers: { ...headers, cookie: `__fs_tk=${token}; app_pref=dark` },
    });
    const forwarded = (await response.json()) as Record<string, string>;
    expect(forwarded.cookie).toBe('app_pref=dark');
    expect(forwarded['x-foundershield-verified']).toBe('1');
    expect(forwarded['x-forwarded-host']).toBe('standard.example.com');
  });
});

describe('strict mode', () => {
  it('withholds the document itself behind an interstitial challenge', async () => {
    const response = await SELF.fetch('https://strict.example.com/', { headers: documentHeaders() });
    expect(response.status).toBe(401);

    const body = await response.text();
    expect(body).toContain('Checking your browser');
    expect(body).not.toContain('protected work');
  });

  it('serves the document after the challenge is solved', async () => {
    const headers = documentHeaders();
    const token = await obtainToken('strict.example.com', headers);

    const response = await SELF.fetch('https://strict.example.com/', {
      headers: { ...headers, cookie: `__fs_tk=${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('protected work');
  });

  it('refuses to issue a token to a browser that reports itself as automated', async () => {
    const headers = documentHeaders();
    const challengeResponse = await SELF.fetch('https://strict.example.com/__fs/v1/challenge', { headers });
    const challenge = (await challengeResponse.json()) as { cid: string; salt: string; difficulty: number };

    let nonce = '';
    for (let i = 0; i < 1_000_000; i++) {
      if (await isValidProofOfWork(challenge.salt, String(i), challenge.difficulty)) {
        nonce = String(i);
        break;
      }
    }

    const response = await SELF.fetch('https://strict.example.com/__fs/v1/verify', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ cid: challenge.cid, nonce, signals: { wd: true } }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'automation_detected' });
  });

  it('rejects a solution for a challenge issued to a different client', async () => {
    const challengeResponse = await SELF.fetch('https://strict.example.com/__fs/v1/challenge', {
      headers: documentHeaders(),
    });
    const challenge = (await challengeResponse.json()) as { cid: string; salt: string; difficulty: number };

    let nonce = '';
    for (let i = 0; i < 1_000_000; i++) {
      if (await isValidProofOfWork(challenge.salt, String(i), challenge.difficulty)) {
        nonce = String(i);
        break;
      }
    }

    const response = await SELF.fetch('https://strict.example.com/__fs/v1/verify', {
      method: 'POST',
      headers: { ...documentHeaders({ 'user-agent': 'curl/8.4.0' }), 'content-type': 'application/json' },
      body: JSON.stringify({ cid: challenge.cid, nonce, signals: {} }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'binding_mismatch' });
  });
});

describe('automation detection', () => {
  it('blocks a self-identifying scraper outright', async () => {
    const response = await SELF.fetch('https://standard.example.com/', {
      headers: { 'user-agent': 'Scrapy/2.11 (+https://scrapy.org)' },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('protected work');
  });

  it('blocks curl', async () => {
    const response = await SELF.fetch('https://standard.example.com/', {
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(response.status).toBe(403);
  });

  it('explains itself in the block page', async () => {
    const response = await SELF.fetch('https://standard.example.com/', {
      headers: { 'user-agent': 'Scrapy/2.11', accept: 'text/html' },
    });
    const body = await response.text();
    expect(body).toContain('Scrapy');
    expect(body).toContain('Reference');
  });

  it('records but does not enforce in monitor mode', async () => {
    const response = await SELF.fetch('https://monitor.example.com/', {
      headers: { 'user-agent': 'Scrapy/2.11', accept: 'text/html' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('protected work');
  });
});

describe('rate limiting', () => {
  it('allows the configured rate then returns 429 with Retry-After', async () => {
    const headers = documentHeaders({ 'cf-connecting-ip': '203.0.113.77' });

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const response = await SELF.fetch('https://limited.example.com/', { headers });
      statuses.push(response.status);
      if (response.status === 429) {
        expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      }
    }

    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses).toContain(429);
  });
});

describe('authorisation boundary', () => {
  it('allows unprotected paths through', async () => {
    const response = await SELF.fetch('https://gated.example.com/about', { headers: documentHeaders() });
    expect(response.status).toBe(200);
  });

  it('blocks a protected route with no session cookie', async () => {
    const response = await SELF.fetch('https://gated.example.com/api/private/customers', { headers: xhrHeaders() });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('protected');
  });

  it('admits the same route once the application session cookie is present', async () => {
    const response = await SELF.fetch('https://gated.example.com/api/private/customers', {
      headers: xhrHeaders({ cookie: 'app_session=abc123' }),
    });
    expect(response.status).toBe(200);
  });

  it('closes a deny route to everyone, session or not', async () => {
    const response = await SELF.fetch('https://gated.example.com/internal/metrics', {
      headers: xhrHeaders({ cookie: 'app_session=abc123' }),
    });
    expect(response.status).toBe(403);
  });

  it('enforces an IP allowlist route', async () => {
    const blocked = await SELF.fetch('https://gated.example.com/partners/feed', {
      headers: xhrHeaders({ 'cf-connecting-ip': '203.0.113.5' }),
    });
    expect(blocked.status).toBe(403);

    const allowed = await SELF.fetch('https://gated.example.com/partners/feed', {
      headers: xhrHeaders({ 'cf-connecting-ip': '198.51.100.22' }),
    });
    expect(allowed.status).toBe(200);
  });
});

describe('clickwrap', () => {
  it('presents the terms before serving content', async () => {
    const response = await SELF.fetch('https://terms.example.com/', { headers: documentHeaders() });
    expect(response.status).toBe(401);

    const body = await response.text();
    expect(body).toContain('I agree');
    expect(body).not.toContain('protected work');
  });

  it('records acceptance and then serves content', async () => {
    const headers = documentHeaders();
    const accept = await SELF.fetch('https://terms.example.com/__fs/v1/clickwrap', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: '/', version: '2' }),
      // Inspect the redirect itself rather than letting fetch follow it.
      redirect: 'manual',
    });
    expect(accept.status).toBe(303);

    const cookie = cookieFrom(accept, '__fs_cw');
    expect(cookie).toBeTruthy();

    const response = await SELF.fetch('https://terms.example.com/', {
      headers: { ...headers, cookie: `__fs_cw=${cookie}` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('protected work');
  });

  it('will not record acceptance of a version the site is not serving', async () => {
    const response = await SELF.fetch('https://terms.example.com/__fs/v1/clickwrap', {
      method: 'POST',
      headers: { ...documentHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: '/', version: '1' }),
    });
    expect(response.status).toBe(409);
  });

  it('refuses an off-site redirect target', async () => {
    const response = await SELF.fetch('https://terms.example.com/__fs/v1/clickwrap', {
      method: 'POST',
      headers: { ...documentHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: 'https://evil.example.com/', version: '2' }),
      redirect: 'manual',
    });
    expect(response.headers.get('location')).toBe('/');
  });
});

describe('response handling', () => {
  it('widens a CSP that would otherwise block the challenge script', async () => {
    const response = await SELF.fetch('https://standard.example.com/strict-csp', { headers: documentHeaders() });
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('https://cdn.example.com');
  });
});

describe('admin endpoint', () => {
  it('rejects a purge with no key', async () => {
    const response = await SELF.fetch('https://standard.example.com/__fs/v1/admin/purge', {
      method: 'POST',
      body: JSON.stringify({ domain: 'standard.example.com' }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects a purge with the wrong key', async () => {
    const response = await SELF.fetch('https://standard.example.com/__fs/v1/admin/purge', {
      method: 'POST',
      headers: { 'x-fs-admin-key': 'not-the-key' },
      body: JSON.stringify({ domain: 'standard.example.com' }),
    });
    expect(response.status).toBe(401);
  });

  it('accepts a purge with the configured key', async () => {
    const response = await SELF.fetch('https://standard.example.com/__fs/v1/admin/purge', {
      method: 'POST',
      headers: { 'x-fs-admin-key': 'test-admin-key' },
      body: JSON.stringify({ domain: 'standard.example.com' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, purged: 'standard.example.com' });
  });
});
