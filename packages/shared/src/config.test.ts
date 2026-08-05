import { describe, expect, it } from 'vitest';
import { DEFAULT_TPM, normaliseConfig } from './config';

const minimal = {
  projectId: 'p1',
  domain: 'App.Example.COM',
  originUrl: 'https://origin.example.com',
  tpmSecret: 'c2VjcmV0',
};

describe('normaliseConfig', () => {
  it('fills defaults and lowercases the domain', () => {
    const config = normaliseConfig(minimal)!;
    expect(config.domain).toBe('app.example.com');
    expect(config.status).toBe('pending');
    expect(config.mode).toBe('standard');
    expect(config.tpm).toEqual(DEFAULT_TPM);
  });

  it('accepts snake_case keys straight from PostgREST', () => {
    const config = normaliseConfig({
      project_id: 'p1',
      domain: 'a.example.com',
      origin_url: 'https://origin.example.com',
      tpm_secret: 'c2VjcmV0',
      rate_limit: { requestsPerMinute: 500 },
      auth_gate: { enabled: true, routes: [{ pattern: '/api/**', mode: 'deny' }] },
    })!;
    expect(config.projectId).toBe('p1');
    expect(config.rateLimit.requestsPerMinute).toBe(500);
    expect(config.authGate.routes[0]).toMatchObject({ pattern: '/api/**', mode: 'deny', enabled: true });
  });

  it('rejects rows missing anything the proxy cannot run without', () => {
    expect(normaliseConfig(null)).toBeNull();
    expect(normaliseConfig({})).toBeNull();
    expect(normaliseConfig({ ...minimal, originUrl: '' })).toBeNull();
    expect(normaliseConfig({ ...minimal, tpmSecret: '' })).toBeNull();
  });

  it('rejects a non-http origin so the proxy cannot be pointed at file:// or javascript:', () => {
    expect(normaliseConfig({ ...minimal, originUrl: 'javascript:alert(1)' })).toBeNull();
    expect(normaliseConfig({ ...minimal, originUrl: 'file:///etc/passwd' })).toBeNull();
    expect(normaliseConfig({ ...minimal, originUrl: 'not a url' })).toBeNull();
  });

  it('clamps out-of-range numbers instead of trusting them', () => {
    const config = normaliseConfig({
      ...minimal,
      tpm: { difficulty: 999, epochSeconds: 0, ttlSeconds: -5 },
      rateLimit: { requestsPerMinute: -1 },
      logging: { sampleRate: 42 },
    })!;
    expect(config.tpm.difficulty).toBe(22);
    expect(config.tpm.epochSeconds).toBe(60);
    expect(config.tpm.ttlSeconds).toBe(60);
    expect(config.rateLimit.requestsPerMinute).toBe(1);
    expect(config.logging.sampleRate).toBe(1);
  });

  it('falls back on garbage values rather than throwing', () => {
    const config = normaliseConfig({
      ...minimal,
      mode: 'chaos',
      status: 'exploded',
      tpm: { difficulty: 'high', exemptPaths: 'not-an-array' },
      bots: { blockedUserAgents: [1, 2, 'real'] },
    })!;
    expect(config.mode).toBe('standard');
    expect(config.status).toBe('pending');
    expect(config.tpm.difficulty).toBe(DEFAULT_TPM.difficulty);
    expect(config.tpm.exemptPaths).toEqual(DEFAULT_TPM.exemptPaths);
    expect(config.bots.blockedUserAgents).toEqual(['real']);
  });

  it('drops malformed protected routes without dropping good ones', () => {
    const config = normaliseConfig({
      ...minimal,
      authGate: { routes: [{ mode: 'deny' }, null, 'nope', { pattern: '/ok/**' }] },
    })!;
    expect(config.authGate.routes).toHaveLength(1);
    expect(config.authGate.routes[0]?.pattern).toBe('/ok/**');
    expect(config.authGate.routes[0]?.mode).toBe('session');
  });
});
