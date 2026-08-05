import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function documentHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'user-agent': CHROME,
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'en-GB,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="131"',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-dest': 'document',
    ...extra,
  };
}

describe('generated terms', () => {
  it('serves the terms it generates', async () => {
    const response = await SELF.fetch('https://generated.example.com/__fs/v1/terms');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const body = await response.text();
    expect(body).toContain('Terms of use');
    expect(body).toContain('Generated Ltd');
    expect(body).toContain('Automated access');
    expect(body).toContain('Access controls');
  });

  it('serves a plain-text rendering for anyone reading it programmatically', async () => {
    const response = await SELF.fetch('https://generated.example.com/__fs/v1/terms.txt');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('reservation of rights');
  });

  it('reports the content-derived version as a header', async () => {
    const response = await SELF.fetch('https://generated.example.com/__fs/v1/terms');
    expect(response.headers.get('x-fs-terms-version')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('404s on a project with no generated terms rather than serving a blank document', async () => {
    const response = await SELF.fetch('https://terms.example.com/__fs/v1/terms');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'no_generated_terms' });
  });
});

describe('machine-readable policy', () => {
  it('publishes the AI refusal the terms promise exists', async () => {
    const response = await SELF.fetch('https://generated.example.com/.well-known/ai-permissions.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const document = (await response.json()) as {
      policies: Record<string, string>;
      reservationOfRights: boolean;
      termsVersion: string;
    };
    expect(document.policies['ai-training']).toBe('deny');
    expect(document.policies['text-and-data-mining']).toBe('deny');
    expect(document.reservationOfRights).toBe(true);
  });

  it('quotes the same version the terms endpoint reports', async () => {
    const terms = await SELF.fetch('https://generated.example.com/__fs/v1/terms');
    const policy = await SELF.fetch('https://generated.example.com/.well-known/ai-permissions.json');
    const document = (await policy.json()) as { termsVersion: string };
    expect(document.termsVersion).toBe(terms.headers.get('x-fs-terms-version'));
  });

  it('serves robots.txt only where the customer opted in', async () => {
    const optedIn = await SELF.fetch('https://generated.example.com/robots.txt');
    expect(optedIn.status).toBe(200);
    expect(optedIn.headers.get('x-foundershield')).toBe('robots');
    expect(await optedIn.text()).toContain('User-agent: GPTBot');

    // This project has generated terms but did not opt in, so the origin's own
    // robots.txt must still be what is served.
    const notOptedIn = await SELF.fetch('https://modaltpm.example.com/robots.txt');
    expect(notOptedIn.headers.get('x-foundershield')).not.toBe('robots');
  });

  it('does not invent policy documents for projects without terms', async () => {
    const response = await SELF.fetch('https://standard.example.com/.well-known/ai-permissions.json');
    expect(response.headers.get('x-foundershield')).not.toBe('ai-permissions');
  });
});

describe('clickwrap presentation', () => {
  it('overlays the notice on the served page in modal mode', async () => {
    const response = await SELF.fetch('https://generated.example.com/', { headers: documentHeaders() });
    expect(response.status).toBe(200);

    const body = await response.text();
    // The page is served -- that is the documented trade-off of modal mode.
    expect(body).toContain('protected work');
    expect(body).toContain('Before you continue');
    expect(body).toContain('/__fs/v1/clickwrap');
    expect(body).toContain('aria-modal="true"');
  });

  it('points the modal at the generated terms, not the configured URL', async () => {
    const response = await SELF.fetch('https://generated.example.com/', { headers: documentHeaders() });
    expect(await response.text()).toContain('href="/__fs/v1/terms"');
  });

  it('stops overlaying once the visitor has accepted', async () => {
    const accept = await SELF.fetch('https://generated.example.com/__fs/v1/clickwrap', {
      method: 'POST',
      headers: { ...documentHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: '/', version: 'abc123def456' }),
      redirect: 'manual',
    });
    expect(accept.status).toBe(303);

    const cookie = /__fs_cw=([^;]+)/.exec(accept.headers.get('set-cookie') ?? '')?.[1];
    expect(cookie).toBeTruthy();

    const response = await SELF.fetch('https://generated.example.com/', {
      headers: documentHeaders({ cookie: `__fs_cw=${cookie}` }),
    });
    const body = await response.text();
    expect(body).toContain('protected work');
    expect(body).not.toContain('Before you continue');
  });

  it('does not apply the overlay to non-document requests', async () => {
    const response = await SELF.fetch('https://generated.example.com/json', {
      headers: { ...documentHeaders(), 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', accept: 'application/json' },
    });
    expect(await response.text()).not.toContain('Before you continue');
  });

  it('still withholds the page when something other than clickwrap is stopping it', async () => {
    // Strict mode plus clickwrap. Which of the two challenges is presented
    // first does not matter -- both withhold the page and the visitor passes
    // through the other on the way back. What matters is that asking for modal
    // presentation did not turn the TPM challenge into an overlay and let the
    // content out.
    const response = await SELF.fetch('https://modaltpm.example.com/', { headers: documentHeaders() });
    expect(response.status).toBe(401);

    const body = await response.text();
    expect(body).not.toContain('protected work');
    expect(body).not.toContain('aria-modal');
  });

  it('keeps withholding the page in interstitial mode', async () => {
    const response = await SELF.fetch('https://terms.example.com/', { headers: documentHeaders() });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('protected work');
  });
});
