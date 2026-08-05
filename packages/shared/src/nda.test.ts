import { describe, expect, it } from 'vitest';
import { generateNda, looksLikeUsJurisdiction, renderNdaText, reviewNda, type NdaInput } from './nda';

const base: NdaInput = {
  disclosingParty: 'Acme Ltd',
  disclosingAddress: '1 Example Street, London',
  receivingParty: 'Sam Contractor',
  mutual: false,
  purpose: 'a contract engineering engagement',
  jurisdiction: 'England and Wales',
  effectiveDate: '2026-08-05',
  termYears: 3,
  perpetualForTradeSecrets: true,
  includeDtsaNotice: false,
  contactEmail: 'legal@acme.example.com',
};

describe('generateNda', () => {
  it('is deterministic and versioned by content', async () => {
    const a = await generateNda(base);
    const b = await generateNda({ ...base });
    expect(a.version).toBe(b.version);
    expect(a.version).toMatch(/^[0-9a-f]{12}$/);
  });

  it('changes version when any term changes, so a signature records exactly what was signed', async () => {
    const original = await generateNda(base);
    const longer = await generateNda({ ...base, termYears: 5 });
    expect(longer.version).not.toBe(original.version);
  });

  it('covers the clauses an NDA needs to do its job', async () => {
    const ids = (await generateNda(base)).sections.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'parties',
        'definition',
        'exclusions',
        'obligations',
        'compelled',
        'term',
        'return',
        'no-rights',
        'remedies',
        'general',
      ]),
    );
  });

  it('describes a one-way agreement as one-way', async () => {
    const text = renderNdaText(await generateNda(base));
    expect(text).toContain('Only Acme Ltd discloses under this agreement');
  });

  it('describes a mutual agreement as mutual', async () => {
    const text = renderNdaText(await generateNda({ ...base, mutual: true }));
    expect(text).toContain('both parties act in both capacities');
  });

  it('protects trade secrets for as long as they stay secret', async () => {
    const text = renderNdaText(await generateNda(base));
    expect(text).toContain('for as long as it remains a trade secret');
  });

  it('bars using disclosed material to train models', async () => {
    const text = renderNdaText(await generateNda(base));
    expect(text).toMatch(/will not use Confidential Information to train/i);
  });

  it('leaves a signature block for both parties', async () => {
    const text = renderNdaText(await generateNda(base));
    expect(text).toContain('Discloser: ');
    expect(text).toContain('Recipient: ');
  });
});

describe('DTSA immunity notice', () => {
  it('is included when asked for, quoting the statutory immunity', async () => {
    const nda = await generateNda({ ...base, jurisdiction: 'the State of Delaware', includeDtsaNotice: true });
    const text = renderNdaText(nda);

    expect(text).toContain('18 U.S.C. § 1833(b)');
    expect(text).toContain('shall not be held criminally or civilly liable');
    expect(text).toContain('under seal');
    expect(nda.sections.some((s) => s.id === 'dtsa-immunity')).toBe(true);
  });

  it('is left out of a non-US agreement', async () => {
    const nda = await generateNda(base);
    expect(nda.sections.some((s) => s.id === 'dtsa-immunity')).toBe(false);
  });

  it('renumbers the general clause so the document stays consistent', async () => {
    const without = await generateNda(base);
    const with_ = await generateNda({ ...base, includeDtsaNotice: true });

    expect(without.sections.at(-1)?.heading).toBe('10. General');
    expect(with_.sections.at(-1)?.heading).toBe('11. General');
  });
});

describe('looksLikeUsJurisdiction', () => {
  it.each([
    ['the State of Delaware', true],
    ['California', true],
    ['the United States', true],
    ['New York', true],
    ['England and Wales', false],
    ['Scotland', false],
    ['Singapore', false],
    ['Germany', false],
  ])('%s -> %s', (jurisdiction, expected) => {
    expect(looksLikeUsJurisdiction(jurisdiction)).toBe(expected);
  });
});

describe('reviewNda', () => {
  it('passes a well-formed non-US agreement without complaint', () => {
    expect(reviewNda(base)).toEqual([]);
  });

  it('flags the omitted DTSA notice on a US agreement, and says what it costs', () => {
    const warnings = reviewNda({ ...base, jurisdiction: 'California', includeDtsaNotice: false });
    const text = warnings.join(' ');
    expect(text).toContain('1836(b)(3)');
    expect(text).toContain('exemplary damages');
  });

  it('flags a DTSA notice on a non-US agreement as out of place', () => {
    const warnings = reviewNda({ ...base, includeDtsaNotice: true });
    expect(warnings.join(' ')).toContain('does not look like a US jurisdiction');
  });

  it('flags a fixed expiry on trade secret protection', () => {
    const warnings = reviewNda({ ...base, perpetualForTradeSecrets: false });
    expect(warnings.join(' ')).toContain('for as long as they stay secret');
  });

  it('flags a very short term', () => {
    expect(reviewNda({ ...base, termYears: 1 }).join(' ')).toContain('short for technical information');
  });

  it('flags a missing counterparty', () => {
    expect(reviewNda({ ...base, disclosingParty: '' }).join(' ')).toContain('needs a counterparty');
  });
});
