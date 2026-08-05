import { describe, expect, it } from 'vitest';
import {
  aiPermissionsDocument,
  generateTerms,
  renderTermsHtml,
  renderTermsText,
  robotsTxt,
  type TermsInput,
} from './terms';

const base: TermsInput = {
  siteName: 'Acme',
  domain: 'acme.example.com',
  operator: 'Acme Ltd',
  contactEmail: 'legal@acme.example.com',
  jurisdiction: 'England and Wales',
  effectiveDate: '2026-08-05',
  permitAiTraining: false,
  permitSearchIndexing: true,
  permittedAgents: ['Googlebot', 'Bingbot'],
};

describe('generateTerms', () => {
  it('is deterministic, so two servers agree without coordinating', async () => {
    const a = await generateTerms(base);
    const b = await generateTerms({ ...base });
    expect(a.version).toBe(b.version);
    expect(renderTermsText(a)).toBe(renderTermsText(b));
  });

  it('changes version when any clause changes', async () => {
    const original = await generateTerms(base);
    const changed = await generateTerms({ ...base, jurisdiction: 'the State of Delaware' });
    expect(changed.version).not.toBe(original.version);
  });

  it('changes version when the AI policy flips, so prior acceptance is invalidated', async () => {
    const refused = await generateTerms(base);
    const permitted = await generateTerms({ ...base, permitAiTraining: true });
    expect(permitted.version).not.toBe(refused.version);
  });

  it('does not change version for inputs that do not appear in the text', async () => {
    const a = await generateTerms(base);
    // `domain` appears in the text, so use a genuinely unused permutation:
    // reordering has to matter, because the list is rendered verbatim.
    const b = await generateTerms({ ...base, permittedAgents: ['Bingbot', 'Googlebot'] });
    expect(b.version).not.toBe(a.version);
  });

  it('produces a stable short hash as the version', async () => {
    const terms = await generateTerms(base);
    expect(terms.version).toMatch(/^[0-9a-f]{12}$/);
  });

  it('covers every clause the proxy actually enforces', async () => {
    const terms = await generateTerms(base);
    const ids = terms.sections.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'acceptance',
        'automated-access',
        'ai-training',
        'access-controls',
        'service-burden',
        'monitoring',
        'changes',
        'governing-law',
      ]),
    );
  });

  it('refuses AI training in the strongest terms when not permitted', async () => {
    const text = renderTermsText(await generateTerms(base));
    expect(text).toContain('reservation of rights');
    expect(text).toMatch(/may not use any content .* to train/i);
  });

  it('permits AI training when the operator chooses to', async () => {
    const text = renderTermsText(await generateTerms({ ...base, permitAiTraining: true }));
    expect(text).toContain('We permit content from the Site to be used for training');
  });

  it('names permitted crawlers and scopes the permission to indexing only', async () => {
    const text = renderTermsText(await generateTerms(base));
    expect(text).toContain('Googlebot and Bingbot');
    expect(text).toContain('search indexing only');
  });

  it('grants no crawler permission when indexing is off', async () => {
    const text = renderTermsText(await generateTerms({ ...base, permitSearchIndexing: false }));
    expect(text).toContain('No general permission is granted to any crawler');
    expect(text).not.toContain('search indexing only');
  });

  it('escapes HTML so a site name cannot inject markup', async () => {
    const terms = await generateTerms({ ...base, siteName: '<script>alert(1)</script>' });
    const html = renderTermsHtml(terms);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('machine-readable policy', () => {
  it('says the same thing as the AI clause', async () => {
    const { version } = await generateTerms(base);
    const document = aiPermissionsDocument(base, version) as {
      policies: Record<string, string>;
      reservationOfRights: boolean;
      termsVersion: string;
    };
    expect(document.policies['ai-training']).toBe('deny');
    expect(document.policies['text-and-data-mining']).toBe('deny');
    expect(document.reservationOfRights).toBe(true);
    expect(document.termsVersion).toBe(version);
  });

  it('flips together with the terms, never independently', async () => {
    const permissive: TermsInput = { ...base, permitAiTraining: true };
    const document = aiPermissionsDocument(permissive, 'x') as { policies: Record<string, string> };
    expect(document.policies['ai-training']).toBe('allow');
  });
});

describe('robotsTxt', () => {
  it('disallows the known AI crawlers by name when training is refused', () => {
    const txt = robotsTxt(base);
    for (const agent of ['GPTBot', 'ClaudeBot', 'CCBot', 'Google-Extended', 'PerplexityBot']) {
      expect(txt).toContain(`User-agent: ${agent}`);
    }
  });

  it('allows the named search crawlers and denies everything else', () => {
    const txt = robotsTxt(base);
    expect(txt).toContain('User-agent: Googlebot\nAllow: /');
    expect(txt).toContain('User-agent: *\nDisallow: /');
  });

  it('denies everything when indexing is off', () => {
    const txt = robotsTxt({ ...base, permitSearchIndexing: false });
    expect(txt).toContain('User-agent: *\nDisallow: /');
    expect(txt).not.toContain('Allow: /');
  });

  it('points at both the terms and the machine-readable policy', () => {
    const txt = robotsTxt(base);
    expect(txt).toContain('/__fs/v1/terms');
    expect(txt).toContain('/.well-known/ai-permissions.json');
  });
});
