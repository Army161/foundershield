import { describe, expect, it } from 'vitest';
import { findProtectedRoute, ipInAny, ipInCidr, matchesAny, patternToRegExp } from './routes';
import type { ProtectedRoute } from './config';

describe('patternToRegExp', () => {
  const cases: Array<[pattern: string, path: string, expected: boolean]> = [
    ['/api/private', '/api/private', true],
    ['/api/private', '/api/private/', true],
    ['/api/private', '/api/private/child', false],
    ['/api/private', '/API/PRIVATE', true],

    ['/api/*', '/api/users', true],
    ['/api/*', '/api/users/1', false],
    ['/api/*', '/api/', true],

    ['/admin/**', '/admin', true],
    ['/admin/**', '/admin/', true],
    ['/admin/**', '/admin/users', true],
    ['/admin/**', '/admin/users/42/edit', true],
    ['/admin/**', '/administrator', false],

    ['**/*.json', '/data/export.json', true],
    ['**/*.json', '/a/b/c/export.json', true],
    ['**/*.json', '/data/export.csv', false],

    // Regex metacharacters in a pattern must be literal.
    ['/pricing?', '/pricing?', true],
    ['/pricing?', '/pricin', false],
    ['/a.b', '/axb', false],
    ['/a.b', '/a.b', true],
  ];

  it.each(cases)('%s vs %s -> %s', (pattern, path, expected) => {
    expect(patternToRegExp(pattern).test(path)).toBe(expected);
  });

  it('is anchored at both ends', () => {
    expect(patternToRegExp('/api').test('/v1/api/x')).toBe(false);
  });
});

describe('matchesAny', () => {
  it('matches the default exempt list', () => {
    const exempt = ['/robots.txt', '/favicon.ico', '/.well-known/**', '/sitemap.xml'];
    expect(matchesAny('/robots.txt', exempt)).toBe(true);
    expect(matchesAny('/.well-known/acme-challenge/abc123', exempt)).toBe(true);
    expect(matchesAny('/api/secret', exempt)).toBe(false);
  });

  it('returns false for an empty list', () => {
    expect(matchesAny('/anything', [])).toBe(false);
  });
});

describe('findProtectedRoute', () => {
  const routes: ProtectedRoute[] = [
    { id: 'a', pattern: '/api/public/**', mode: 'session', enabled: false },
    { id: 'b', pattern: '/api/**', mode: 'session', enabled: true },
    { id: 'c', pattern: '/admin/**', mode: 'deny', enabled: true },
  ];

  it('skips disabled routes and returns the first enabled match', () => {
    expect(findProtectedRoute('/api/public/list', routes)?.id).toBe('b');
    expect(findProtectedRoute('/admin/settings', routes)?.id).toBe('c');
  });

  it('returns null when nothing matches', () => {
    expect(findProtectedRoute('/about', routes)).toBeNull();
  });
});

describe('ipInCidr', () => {
  it.each([
    ['192.168.1.5', '192.168.1.0/24', true],
    ['192.168.2.5', '192.168.1.0/24', false],
    ['10.0.0.1', '10.0.0.1', true],
    ['10.0.0.2', '10.0.0.1', false],
    ['203.0.113.130', '203.0.113.128/25', true],
    ['203.0.113.127', '203.0.113.128/25', false],
    ['1.2.3.4', '0.0.0.0/0', true],
    ['2001:db8::1', '2001:db8::/32', true],
    ['2001:db9::1', '2001:db8::/32', false],
    ['fe80::1%eth0', 'fe80::/10', true],
  ])('%s in %s -> %s', (ip, cidr, expected) => {
    expect(ipInCidr(ip, cidr)).toBe(expected);
  });

  it('never throws on malformed input', () => {
    expect(ipInCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('10.0.0.1', 'garbage')).toBe(false);
    expect(ipInCidr('10.0.0.1', '10.0.0.0/99')).toBe(false);
    expect(ipInCidr('999.1.1.1', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('10.0.0.1', '')).toBe(false);
  });

  it('does not mix address families', () => {
    expect(ipInCidr('10.0.0.1', '::/0')).toBe(false);
  });

  it('checks a list', () => {
    expect(ipInAny('10.1.2.3', ['192.168.0.0/16', '10.0.0.0/8'])).toBe(true);
    expect(ipInAny('172.16.0.1', ['192.168.0.0/16', '10.0.0.0/8'])).toBe(false);
  });
});
