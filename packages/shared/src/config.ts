/**
 * The protection policy that the edge worker enforces for a single domain.
 *
 * This shape is the contract between the dashboard (which writes it), Supabase
 * (which stores it) and the worker (which reads it). Everything is normalised
 * through `normaliseConfig` so a partially-written row from an older dashboard
 * build can never crash the proxy — missing fields fall back to defaults.
 */

import type { TermsInput } from './terms';

export type ProjectStatus = 'pending' | 'active' | 'paused';

/**
 * How aggressively the TPM layer is applied.
 * - `monitor`  : never blocks. Logs what *would* have been blocked. Use this
 *                for the first 24-48h on a live domain.
 * - `standard` : HTML documents are served and carry the challenge; API/XHR and
 *                non-document requests require a valid token.
 * - `strict`   : nothing reaches the origin without a valid token. The first
 *                request gets an interstitial challenge page.
 */
export type ProtectionMode = 'monitor' | 'standard' | 'strict';

export type RouteMode = 'session' | 'clickwrap' | 'apikey' | 'ip_allowlist' | 'deny';

export interface ProtectedRoute {
  id: string;
  /** Glob-ish path pattern: `*` matches one segment, `**` matches any depth. */
  pattern: string;
  mode: RouteMode;
  /** Applies only to `apikey` mode: sha-256 hex digests of accepted keys. */
  keyHashes?: string[];
  /** Applies only to `ip_allowlist` mode. */
  cidrs?: string[];
  /** Human-readable label surfaced in the evidence log. */
  label?: string;
  enabled: boolean;
}

export interface TpmSettings {
  enabled: boolean;
  /** Seconds between rolling-key rotations. */
  epochSeconds: number;
  /** Lifetime of an issued token, in seconds. */
  ttlSeconds: number;
  /** Proof-of-work difficulty in leading zero bits. 10-22 is the sane range. */
  difficulty: number;
  /** Bind the token to the client IP. Breaks mobile network hand-offs if strict. */
  bindIp: boolean;
  bindUserAgent: boolean;
  /** Paths that always require a token, even in `standard` mode. */
  protectPaths: string[];
  /** Paths that never require a token (webhooks, health checks, OAuth callbacks). */
  exemptPaths: string[];
}

export interface RateLimitSettings {
  enabled: boolean;
  requestsPerMinute: number;
  /** Extra requests tolerated in a burst before the window average applies. */
  burst: number;
  /** How long a client stays banned after tripping the limit. */
  banSeconds: number;
}

export interface BotSettings {
  enabled: boolean;
  /** 0-100. Requests scoring at or above this are blocked. */
  blockScore: number;
  /** Requests at or above this but below `blockScore` get a challenge instead. */
  challengeScore: number;
  /** Let Cloudflare-verified crawlers (Googlebot, Bingbot...) straight through. */
  allowVerifiedBots: boolean;
  /** Extra user-agent substrings to always block (case-insensitive). */
  blockedUserAgents: string[];
  /** Extra user-agent substrings to always allow (case-insensitive). */
  allowedUserAgents: string[];
}

export interface AuthGateSettings {
  enabled: boolean;
  /** Cookie the customer's own app sets once a user is logged in. */
  authCookieName: string;
  /** Where to send an unauthenticated visitor. */
  loginPath: string;
  routes: ProtectedRoute[];
}

export interface ClickwrapSettings {
  enabled: boolean;
  /**
   * Bumping this invalidates every previously recorded acceptance. When
   * `terms` is present this is the generated content hash, so editing a clause
   * necessarily re-asks everyone.
   */
  version: string;
  /** Where the terms live. Ignored when `terms` is set. */
  tosUrl: string;
  /** Paths gated behind acceptance. Empty means the whole site. */
  requiredPaths: string[];
  /**
   * Inputs for terms FounderShield generates and serves itself. Stored rather
   * than the rendered document so the edge can re-render deterministically and
   * the config stays small.
   */
  terms: TermsInput | null;
  /**
   * `interstitial` withholds the page until the visitor accepts.
   * `modal` serves the page and overlays the notice — better looking, but the
   * content has already left the server, so it only supports contract
   * formation, not access control. The dashboard states that trade-off.
   */
  presentation: 'interstitial' | 'modal';
  /**
   * Serve a generated `/robots.txt` in place of the origin's. Opt-in, because
   * unlike `/.well-known/ai-permissions.json` this path very often already
   * exists and silently replacing it would be an unpleasant surprise.
   */
  serveRobotsTxt: boolean;
}

export interface LoggingSettings {
  /** Fraction (0-1) of *allowed* requests written to the evidence log. */
  sampleRate: number;
  /** Blocked and challenged requests are always logged; this adds allowed ones. */
  logAllowed: boolean;
}

export interface EdgeProjectConfig {
  projectId: string;
  domain: string;
  /** Absolute origin URL, e.g. `https://origin.example.com`. */
  originUrl: string;
  status: ProjectStatus;
  mode: ProtectionMode;
  /** base64url-encoded 32-byte project secret. */
  tpmSecret: string;
  tpm: TpmSettings;
  rateLimit: RateLimitSettings;
  bots: BotSettings;
  authGate: AuthGateSettings;
  clickwrap: ClickwrapSettings;
  logging: LoggingSettings;
  ipAllowlist: string[];
  ipBlocklist: string[];
}

export const DEFAULT_TPM: TpmSettings = {
  enabled: true,
  epochSeconds: 900,
  ttlSeconds: 3600,
  difficulty: 14,
  bindIp: false,
  bindUserAgent: true,
  protectPaths: [],
  exemptPaths: ['/robots.txt', '/favicon.ico', '/.well-known/**', '/sitemap.xml'],
};

export const DEFAULT_RATE_LIMIT: RateLimitSettings = {
  enabled: true,
  requestsPerMinute: 120,
  burst: 40,
  banSeconds: 60,
};

export const DEFAULT_BOTS: BotSettings = {
  enabled: true,
  blockScore: 70,
  challengeScore: 40,
  allowVerifiedBots: true,
  blockedUserAgents: [],
  allowedUserAgents: [],
};

export const DEFAULT_AUTH_GATE: AuthGateSettings = {
  enabled: false,
  authCookieName: 'session',
  loginPath: '/login',
  routes: [],
};

export const DEFAULT_CLICKWRAP: ClickwrapSettings = {
  enabled: false,
  version: '1',
  tosUrl: '/terms',
  requiredPaths: [],
  terms: null,
  presentation: 'interstitial',
  serveRobotsTxt: false,
};

export const DEFAULT_LOGGING: LoggingSettings = {
  sampleRate: 0.02,
  logAllowed: true,
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Terms inputs must be fully populated or absent — a half-written record would
 * render a document with blanks in it, which is worse than no document at all.
 */
function normaliseTerms(value: unknown, domain: string): TermsInput | null {
  if (!value || typeof value !== 'object') return null;
  const t = value as Record<string, unknown>;

  const siteName = str(t.siteName, '');
  const operator = str(t.operator, '');
  if (!siteName || !operator) return null;

  return {
    siteName,
    domain: str(t.domain, domain),
    operator,
    contactEmail: str(t.contactEmail, ''),
    jurisdiction: str(t.jurisdiction, 'England and Wales'),
    effectiveDate: str(t.effectiveDate, new Date(0).toISOString().slice(0, 10)),
    permitAiTraining: bool(t.permitAiTraining, false),
    permitSearchIndexing: bool(t.permitSearchIndexing, true),
    permittedAgents: stringArray(t.permittedAgents, ['Googlebot', 'Bingbot']),
  };
}

function normaliseRoutes(value: unknown): ProtectedRoute[] {
  if (!Array.isArray(value)) return [];
  const out: ProtectedRoute[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.pattern !== 'string' || r.pattern.length === 0) continue;
    out.push({
      id: str(r.id, r.pattern),
      pattern: r.pattern,
      mode: oneOf(r.mode, ['session', 'clickwrap', 'apikey', 'ip_allowlist', 'deny'] as const, 'session'),
      keyHashes: stringArray(r.keyHashes, []),
      cidrs: stringArray(r.cidrs, []),
      label: typeof r.label === 'string' ? r.label : undefined,
      enabled: bool(r.enabled, true),
    });
  }
  return out;
}

/**
 * Turn whatever came back from the database into a config the worker can trust.
 * Never throws: an unusable row degrades to "pending" (pure pass-through).
 */
export function normaliseConfig(raw: unknown): EdgeProjectConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;

  const projectId = str(c.projectId ?? c.project_id, '');
  const domain = str(c.domain, '').toLowerCase();
  const originUrl = str(c.originUrl ?? c.origin_url, '');
  const tpmSecret = str(c.tpmSecret ?? c.tpm_secret, '');
  if (!projectId || !domain || !originUrl || !tpmSecret) return null;

  try {
    // Reject anything that is not an absolute http(s) origin.
    const parsed = new URL(originUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  } catch {
    return null;
  }

  const tpm = (c.tpm ?? {}) as Record<string, unknown>;
  const rl = (c.rateLimit ?? c.rate_limit ?? {}) as Record<string, unknown>;
  const bots = (c.bots ?? {}) as Record<string, unknown>;
  const gate = (c.authGate ?? c.auth_gate ?? {}) as Record<string, unknown>;
  const cw = (c.clickwrap ?? {}) as Record<string, unknown>;
  const log = (c.logging ?? {}) as Record<string, unknown>;

  return {
    projectId,
    domain,
    originUrl,
    status: oneOf(c.status, ['pending', 'active', 'paused'] as const, 'pending'),
    mode: oneOf(c.mode, ['monitor', 'standard', 'strict'] as const, 'standard'),
    tpmSecret,
    tpm: {
      enabled: bool(tpm.enabled, DEFAULT_TPM.enabled),
      epochSeconds: clamp(tpm.epochSeconds, 60, 86400, DEFAULT_TPM.epochSeconds),
      ttlSeconds: clamp(tpm.ttlSeconds, 60, 86400, DEFAULT_TPM.ttlSeconds),
      difficulty: clamp(tpm.difficulty, 8, 22, DEFAULT_TPM.difficulty),
      bindIp: bool(tpm.bindIp, DEFAULT_TPM.bindIp),
      bindUserAgent: bool(tpm.bindUserAgent, DEFAULT_TPM.bindUserAgent),
      protectPaths: stringArray(tpm.protectPaths, DEFAULT_TPM.protectPaths),
      exemptPaths: stringArray(tpm.exemptPaths, DEFAULT_TPM.exemptPaths),
    },
    rateLimit: {
      enabled: bool(rl.enabled, DEFAULT_RATE_LIMIT.enabled),
      requestsPerMinute: clamp(rl.requestsPerMinute, 1, 100000, DEFAULT_RATE_LIMIT.requestsPerMinute),
      burst: clamp(rl.burst, 0, 100000, DEFAULT_RATE_LIMIT.burst),
      banSeconds: clamp(rl.banSeconds, 0, 86400, DEFAULT_RATE_LIMIT.banSeconds),
    },
    bots: {
      enabled: bool(bots.enabled, DEFAULT_BOTS.enabled),
      blockScore: clamp(bots.blockScore, 1, 100, DEFAULT_BOTS.blockScore),
      challengeScore: clamp(bots.challengeScore, 1, 100, DEFAULT_BOTS.challengeScore),
      allowVerifiedBots: bool(bots.allowVerifiedBots, DEFAULT_BOTS.allowVerifiedBots),
      blockedUserAgents: stringArray(bots.blockedUserAgents, []),
      allowedUserAgents: stringArray(bots.allowedUserAgents, []),
    },
    authGate: {
      enabled: bool(gate.enabled, DEFAULT_AUTH_GATE.enabled),
      authCookieName: str(gate.authCookieName, DEFAULT_AUTH_GATE.authCookieName),
      loginPath: str(gate.loginPath, DEFAULT_AUTH_GATE.loginPath),
      routes: normaliseRoutes(gate.routes),
    },
    clickwrap: {
      enabled: bool(cw.enabled, DEFAULT_CLICKWRAP.enabled),
      version: str(cw.version, DEFAULT_CLICKWRAP.version),
      tosUrl: str(cw.tosUrl, DEFAULT_CLICKWRAP.tosUrl),
      requiredPaths: stringArray(cw.requiredPaths, []),
      terms: normaliseTerms(cw.terms, domain),
      presentation: oneOf(cw.presentation, ['interstitial', 'modal'] as const, 'interstitial'),
      serveRobotsTxt: bool(cw.serveRobotsTxt, DEFAULT_CLICKWRAP.serveRobotsTxt),
    },
    logging: {
      sampleRate: clamp(log.sampleRate, 0, 1, DEFAULT_LOGGING.sampleRate),
      logAllowed: bool(log.logAllowed, DEFAULT_LOGGING.logAllowed),
    },
    ipAllowlist: stringArray(c.ipAllowlist ?? c.ip_allowlist, []),
    ipBlocklist: stringArray(c.ipBlocklist ?? c.ip_blocklist, []),
  };
}

export function defaultSettings() {
  return {
    mode: 'standard' as ProtectionMode,
    tpm: { ...DEFAULT_TPM },
    rateLimit: { ...DEFAULT_RATE_LIMIT },
    bots: { ...DEFAULT_BOTS },
    authGate: { ...DEFAULT_AUTH_GATE },
    clickwrap: { ...DEFAULT_CLICKWRAP },
    logging: { ...DEFAULT_LOGGING },
  };
}
