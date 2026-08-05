import { describe, expect, it } from 'vitest';
import { assessBotLikelihood, matchesUserAgentList, type BotSignalInput } from './bots';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function request(overrides: Partial<BotSignalInput> = {}): BotSignalInput {
  return {
    userAgent: CHROME,
    accept: 'text/html,application/xhtml+xml',
    acceptLanguage: 'en-GB,en;q=0.9',
    acceptEncoding: 'gzip, deflate, br',
    secChUa: '"Chromium";v="131"',
    secFetchMode: 'navigate',
    secFetchSite: 'none',
    secFetchDest: 'document',
    connection: null,
    method: 'GET',
    hasCookies: true,
    ...overrides,
  };
}

describe('assessBotLikelihood', () => {
  it('scores a well-formed Chrome request near zero', () => {
    const result = assessBotLikelihood(request());
    expect(result.score).toBe(0);
    expect(result.signals).toEqual([]);
  });

  it('flags self-identifying scrapers strongly', () => {
    const result = assessBotLikelihood(
      request({ userAgent: 'Scrapy/2.11 (+https://scrapy.org)', secChUa: null, secFetchMode: null, acceptLanguage: null }),
    );
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.signals.map((s) => s.id)).toContain('ua.scrapy');
  });

  it.each([
    ['curl/8.4.0', 'ua.curl'],
    ['python-requests/2.32.3', 'ua.python'],
    ['Go-http-client/2.0', 'ua.go'],
    ['node-fetch/1.0', 'ua.node'],
    ['Mozilla/5.0 HeadlessChrome/120.0.0.0', 'ua.headless'],
    ['sqlmap/1.8', 'ua.scanner'],
    ['GPTBot/1.2', 'ua.ai'],
  ])('identifies %s', (userAgent, expectedRule) => {
    const result = assessBotLikelihood(request({ userAgent, secChUa: null, secFetchMode: null }));
    expect(result.signals.map((s) => s.id)).toContain(expectedRule);
  });

  it('catches a client spoofing Chrome but missing client hints', () => {
    const result = assessBotLikelihood(
      request({ secChUa: null, secFetchMode: null, acceptLanguage: null, acceptEncoding: null }),
    );
    expect(result.signals.map((s) => s.id)).toEqual(
      expect.arrayContaining(['hdr.no_sec_ch_ua', 'hdr.no_sec_fetch', 'hdr.no_accept_language']),
    );
    expect(result.score).toBeGreaterThan(50);
  });

  it('does not block on a single weak header quirk', () => {
    // Only Accept-Encoding missing — annoying, but not a scraper on its own.
    const result = assessBotLikelihood(request({ acceptEncoding: null }));
    expect(result.score).toBeLessThan(40);
  });

  it('adds datacentre origin as a contributing, not decisive, signal', () => {
    const consumer = assessBotLikelihood(request({ asOrganisation: 'BT Broadband' }));
    const datacentre = assessBotLikelihood(request({ asOrganisation: 'Amazon.com, Inc.' }));
    expect(consumer.score).toBe(0);
    expect(datacentre.score).toBeGreaterThan(0);
    expect(datacentre.score).toBeLessThan(70);
  });

  it('treats an absent user-agent as suspicious', () => {
    const result = assessBotLikelihood(request({ userAgent: '' }));
    expect(result.signals.map((s) => s.id)).toContain('ua.absent');
  });

  it('marks network-verified search crawlers', () => {
    const result = assessBotLikelihood(
      request({ userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)', verifiedBotCategory: 'Search Engine Crawler' }),
    );
    expect(result.verifiedSearchBot).toBe(true);
  });

  it('does not treat an unverified Googlebot claim as verified', () => {
    const result = assessBotLikelihood(
      request({ userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)', verifiedBotCategory: null }),
    );
    expect(result.verifiedSearchBot).toBe(false);
  });

  it('keeps every score inside 0-100', () => {
    const result = assessBotLikelihood(
      request({ userAgent: 'sqlmap nikto masscan scrapy puppeteer', accept: null, acceptLanguage: null, acceptEncoding: null, secChUa: null, secFetchMode: null, hasCookies: false, asOrganisation: 'Hetzner Online GmbH' }),
    );
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

describe('matchesUserAgentList', () => {
  it('matches case-insensitively on substrings', () => {
    expect(matchesUserAgentList('Mozilla/5.0 EvilBot/1.0', ['evilbot'])).toBe('evilbot');
    expect(matchesUserAgentList('Mozilla/5.0', ['evilbot'])).toBeNull();
  });

  it('ignores blank entries from a textarea', () => {
    expect(matchesUserAgentList('Mozilla/5.0', ['', '   '])).toBeNull();
  });
});
