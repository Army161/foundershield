/**
 * Test projects served to the worker through `FS_CONFIG_FALLBACK`, which is the
 * same code path a real deployment uses when Supabase is unreachable.
 *
 * Difficulty is deliberately low so the suite stays fast; the proof-of-work
 * logic itself is exercised at realistic difficulty in the shared package.
 */

export const TPM_SECRET = 'dGVzdC1zZWNyZXQtZm9yLWZvdW5kZXJzaGllbGQtMDAx';

const base = {
  originUrl: 'https://origin.test',
  status: 'active',
  tpmSecret: TPM_SECRET,
  tpm: {
    enabled: true,
    epochSeconds: 900,
    ttlSeconds: 3600,
    difficulty: 10,
    bindIp: false,
    bindUserAgent: true,
    protectPaths: [],
    exemptPaths: ['/robots.txt', '/.well-known/**'],
  },
  rateLimit: { enabled: false, requestsPerMinute: 120, burst: 40, banSeconds: 60 },
  bots: {
    enabled: true,
    blockScore: 70,
    challengeScore: 40,
    allowVerifiedBots: true,
    blockedUserAgents: [],
    allowedUserAgents: [],
  },
  authGate: { enabled: false, authCookieName: 'session', loginPath: '/login', routes: [] },
  clickwrap: { enabled: false, version: '1', tosUrl: '/terms', requiredPaths: [] },
  logging: { sampleRate: 0, logAllowed: false },
  ipAllowlist: [],
  ipBlocklist: [],
};

export const PROJECTS = [
  { ...base, projectId: 'p-standard', domain: 'standard.example.com', mode: 'standard' },
  { ...base, projectId: 'p-strict', domain: 'strict.example.com', mode: 'strict' },
  { ...base, projectId: 'p-monitor', domain: 'monitor.example.com', mode: 'monitor' },
  { ...base, projectId: 'p-paused', domain: 'paused.example.com', mode: 'strict', status: 'paused' },
  {
    ...base,
    projectId: 'p-limited',
    domain: 'limited.example.com',
    mode: 'standard',
    tpm: { ...base.tpm, enabled: false },
    rateLimit: { enabled: true, requestsPerMinute: 5, burst: 0, banSeconds: 30 },
  },
  {
    ...base,
    projectId: 'p-gated',
    domain: 'gated.example.com',
    mode: 'standard',
    tpm: { ...base.tpm, enabled: false },
    authGate: {
      enabled: true,
      authCookieName: 'app_session',
      loginPath: '/login',
      routes: [
        { id: 'r1', pattern: '/api/private/**', mode: 'session', enabled: true, label: 'Private API' },
        { id: 'r2', pattern: '/internal/**', mode: 'deny', enabled: true },
        { id: 'r3', pattern: '/partners/**', mode: 'ip_allowlist', cidrs: ['198.51.100.0/24'], enabled: true },
      ],
    },
  },
  {
    ...base,
    projectId: 'p-terms',
    domain: 'terms.example.com',
    mode: 'standard',
    tpm: { ...base.tpm, enabled: false },
    clickwrap: { enabled: true, version: '2', tosUrl: '/terms', requiredPaths: [] },
  },
];

export const ORIGIN_HTML = '<!doctype html><html><head><title>Origin</title></head><body>protected work</body></html>';
