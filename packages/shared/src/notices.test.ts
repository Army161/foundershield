import { describe, expect, it } from 'vitest';
import {
  generateAccessDemand,
  generateCircumventionDemand,
  generateDmcaNotice,
  type DemandInput,
  type DmcaInput,
  type IncidentSummary,
} from './notices';

const completeDmca: DmcaInput = {
  signatoryName: 'Alex Founder',
  signatoryTitle: 'Director',
  signatoryEmail: 'alex@acme.example.com',
  signatoryPhone: '+44 20 7000 0000',
  signatoryAddress: '1 Example Street, London',
  rightsHolder: 'Acme Ltd',
  workDescription: 'The written guides published at acme.example.com/guides.',
  originalUrls: ['https://acme.example.com/guides/one'],
  infringingUrls: ['https://copycat.example.net/stolen/one'],
  serviceProvider: 'Example Host Inc.',
  goodFaithBelief: true,
  accuracyStatement: true,
  authorityStatement: true,
};

const incident: IncidentSummary = {
  ip: '203.0.113.10',
  firstSeen: '2026-08-01 10:00:00 UTC',
  lastSeen: '2026-08-01 10:00:39 UTC',
  requests: 40,
  blocked: 40,
  peakPerMinute: 40,
  distinctPaths: 40,
  bytesServed: 40000,
  userAgents: ['Scrapy/2.11'],
  ruleIds: ['ua.scrapy'],
  asOrganisation: 'Example Hosting',
  country: 'US',
};

const demand: DemandInput = {
  senderName: 'Alex Founder',
  senderEntity: 'Acme Ltd',
  senderEmail: 'alex@acme.example.com',
  domain: 'acme.example.com',
  recipientDescription: 'Example Hosting abuse team',
  incidents: [incident],
  termsInForce: true,
  termsVersion: 'abc123',
  gatedRoutes: true,
  periodFrom: '2026-08-01',
  periodTo: '2026-08-02',
};

describe('DMCA notice', () => {
  it('drafts a complete notice when every element is present', () => {
    const result = generateDmcaNotice(completeDmca);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.document.body).toContain('17 U.S.C. § 512(c)');
    expect(result.document.body).toContain('https://copycat.example.net/stolen/one');
    expect(result.document.body).toContain('good faith belief');
    expect(result.document.body).toContain('under penalty of perjury');
    expect(result.document.addressee).toContain('Example Host Inc.');
  });

  it.each([
    ['signatoryName', { signatoryName: '' }],
    ['workDescription', { workDescription: '' }],
    ['originalUrls', { originalUrls: [] }],
    ['infringingUrls', { infringingUrls: [] }],
    ['serviceProvider', { serviceProvider: '' }],
  ])('refuses to draft without %s', (_label, override) => {
    const result = generateDmcaNotice({ ...completeDmca, ...override } as DmcaInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it('will not assert good faith on the sender’s behalf', () => {
    const result = generateDmcaNotice({ ...completeDmca, goodFaithBelief: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing.join(' ')).toContain('good-faith belief');
  });

  it('will not swear the perjury statements on the sender’s behalf', () => {
    const noAccuracy = generateDmcaNotice({ ...completeDmca, accuracyStatement: false });
    const noAuthority = generateDmcaNotice({ ...completeDmca, authorityStatement: false });
    expect(noAccuracy.ok).toBe(false);
    expect(noAuthority.ok).toBe(false);
  });

  it('accepts an email or a phone number as contact, but not neither', () => {
    expect(generateDmcaNotice({ ...completeDmca, signatoryPhone: '' }).ok).toBe(true);
    expect(generateDmcaNotice({ ...completeDmca, signatoryEmail: '' }).ok).toBe(true);

    const neither = generateDmcaNotice({ ...completeDmca, signatoryEmail: '', signatoryPhone: '' });
    expect(neither.ok).toBe(false);
  });

  it('warns about fair use and section 512(f) before anything is sent', () => {
    const result = generateDmcaNotice(completeDmca);
    if (!result.ok) throw new Error('expected a draft');
    expect(result.cautions.join(' ')).toContain('512(f)');
    expect(result.cautions.join(' ')).toContain('fair use');
    expect(result.cautions.join(' ')).toContain('designated agent');
  });
});

describe('circumvention demand', () => {
  it('drafts from recorded incidents', () => {
    const result = generateCircumventionDemand(demand);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.document.body).toContain('203.0.113.10');
    expect(result.document.body).toContain('40 requests');
    expect(result.document.body).toContain('acme.example.com');
  });

  it('states plainly when no token was actually forged, and softens the letter', () => {
    const result = generateCircumventionDemand(demand);
    if (!result.ok) throw new Error('expected a draft');

    expect(result.cautions[0]).toContain('materially weaker than circumvention');
    expect(result.document.body).not.toContain('it was constructed');
  });

  it('sharpens the letter when a forged token was recorded', () => {
    const forged: IncidentSummary = { ...incident, ruleIds: ['tpm.bad_signature'] };
    const result = generateCircumventionDemand({ ...demand, incidents: [forged] });
    if (!result.ok) throw new Error('expected a draft');

    expect(result.document.body).toContain('was constructed');
    expect(result.cautions.join(' ')).not.toContain('materially weaker than circumvention');
  });

  it('always warns that section 1201 is contested and that an address is not a person', () => {
    const result = generateCircumventionDemand(demand);
    if (!result.ok) throw new Error('expected a draft');
    const text = result.cautions.join(' ');
    expect(text).toContain('§ 1201');
    expect(text).toContain('not a person');
  });

  it('refuses to draft with no incidents', () => {
    const result = generateCircumventionDemand({ ...demand, incidents: [] });
    expect(result.ok).toBe(false);
  });
});

describe('access demand', () => {
  it('rests on the gate when gated routes were touched', () => {
    const gated: IncidentSummary = { ...incident, ruleIds: ['gate.no_session'] };
    const result = generateAccessDemand({ ...demand, incidents: [gated] });
    if (!result.ok) throw new Error('expected a draft');

    expect(result.document.body).toContain('closed to unauthenticated access');
    expect(result.cautions.join(' ')).not.toContain('hiQ');
  });

  it('warns about hiQ when only public pages were touched', () => {
    const result = generateAccessDemand(demand);
    if (!result.ok) throw new Error('expected a draft');
    expect(result.cautions[0]).toContain('hiQ');
    expect(result.cautions[0]).toContain('publicly available data');
  });

  it('warns when no terms were in force, since the demand then rests on nothing agreed', () => {
    const result = generateAccessDemand({ ...demand, termsInForce: false });
    if (!result.ok) throw new Error('expected a draft');
    expect(result.cautions[0]).toContain('no record that this actor agreed');
  });

  it('references the accepted terms version when there was one', () => {
    const result = generateAccessDemand(demand);
    if (!result.ok) throw new Error('expected a draft');
    expect(result.document.body).toContain('version abc123');
  });
});

describe('every generator', () => {
  it('produces a draft and never a sent message', () => {
    const dmca = generateDmcaNotice(completeDmca);
    const circumvention = generateCircumventionDemand(demand);
    const access = generateAccessDemand(demand);

    for (const result of [dmca, circumvention, access]) {
      if (!result.ok) throw new Error('expected a draft');
      // Every document ends with an unsigned, undated signature block.
      expect(result.document.body).toContain('Date: ____________');
      expect(result.cautions.join(' ')).toContain('lawyer');
    }
  });
});
