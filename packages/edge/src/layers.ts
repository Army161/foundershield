/**
 * The protection layers, in the order they run.
 *
 * Every layer returns zero or more `DecisionReason`s. Nothing short-circuits
 * except an explicit allowlist hit, because the evidence record is far more
 * useful when it says "this request tripped four independent measures" than
 * when it says "blocked". `resolveDecision` then picks what actually happens.
 */

import {
  assessBotLikelihood,
  findProtectedRoute,
  ipInAny,
  matchesAny,
  matchesUserAgentList,
  verifyClickwrap,
  verifyToken,
  CLICKWRAP_COOKIE,
  TOKEN_COOKIE,
  TOKEN_HEADER,
  type DecisionReason,
  type EdgeProjectConfig,
  type TokenClaims,
} from '@foundershield/shared';
import { bindingFor, hashIp, type RequestContext } from './context.js';
import { checkRateLimitLocally, type RateLimitQuery, type RateLimitVerdict } from './durable/rate-limiter.js';
import type { Env } from './env.js';

export interface Assessment {
  reasons: DecisionReason[];
  botScore: number;
  tokenClaims: TokenClaims | null;
  /** Set when an allowlist rule terminated evaluation early. */
  allowlisted: boolean;
  retryAfterSeconds: number;
  ipHash: string;
}

// ---------------------------------------------------------------------------
// Access lists
// ---------------------------------------------------------------------------

function evaluateAccessLists(context: RequestContext, config: EdgeProjectConfig): {
  reasons: DecisionReason[];
  terminal: boolean;
} {
  const reasons: DecisionReason[] = [];

  if (config.ipBlocklist.length > 0 && ipInAny(context.ip, config.ipBlocklist)) {
    reasons.push({
      layer: 'blocklist',
      ruleId: 'ip.blocklist',
      description: `Request came from ${context.ip}, which the site owner had explicitly blocked`,
      action: 'block',
    });
    return { reasons, terminal: true };
  }

  const blockedUa = matchesUserAgentList(context.userAgent, config.bots.blockedUserAgents);
  if (blockedUa) {
    reasons.push({
      layer: 'blocklist',
      ruleId: 'ua.blocklist',
      description: `User-agent matched the site owner's blocklist entry "${blockedUa}"`,
      action: 'block',
    });
    return { reasons, terminal: true };
  }

  if (config.ipAllowlist.length > 0 && ipInAny(context.ip, config.ipAllowlist)) {
    return { reasons, terminal: true };
  }

  if (matchesUserAgentList(context.userAgent, config.bots.allowedUserAgents)) {
    return { reasons, terminal: true };
  }

  return { reasons, terminal: false };
}

// ---------------------------------------------------------------------------
// Automation detection
// ---------------------------------------------------------------------------

function evaluateBots(context: RequestContext, config: EdgeProjectConfig): {
  reasons: DecisionReason[];
  score: number;
  terminal: boolean;
} {
  const headers = context.request.headers;
  const assessment = assessBotLikelihood({
    userAgent: context.userAgent,
    accept: headers.get('accept'),
    acceptLanguage: headers.get('accept-language'),
    acceptEncoding: headers.get('accept-encoding'),
    secChUa: headers.get('sec-ch-ua'),
    secFetchMode: headers.get('sec-fetch-mode'),
    secFetchSite: headers.get('sec-fetch-site'),
    secFetchDest: headers.get('sec-fetch-dest'),
    connection: headers.get('connection'),
    method: context.method,
    hasCookies: context.cookies.size > 0,
    verifiedBotCategory: context.verifiedBotCategory,
    asOrganisation: context.asOrganisation,
  });

  if (assessment.verifiedSearchBot && config.bots.allowVerifiedBots) {
    return { reasons: [], score: assessment.score, terminal: true };
  }

  if (!config.bots.enabled) {
    return { reasons: [], score: assessment.score, terminal: false };
  }

  const action =
    assessment.score >= config.bots.blockScore
      ? 'block'
      : assessment.score >= config.bots.challengeScore
        ? 'challenge'
        : null;

  if (!action) return { reasons: [], score: assessment.score, terminal: false };

  // Report the strongest contributing signal, but describe the whole picture.
  const strongest = [...assessment.signals].sort((a, b) => b.score - a.score)[0];
  const reasons: DecisionReason[] = [
    {
      layer: 'bots',
      ruleId: strongest?.id ?? 'bot.score',
      description:
        assessment.signals.length === 1 || !strongest
          ? (strongest?.description ?? `Automation score ${assessment.score}`)
          : `${strongest.description} (automation score ${assessment.score} from ${assessment.signals.length} independent signals)`,
      action,
    },
  ];

  return { reasons, score: assessment.score, terminal: false };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

async function queryRateLimiter(env: Env, projectId: string, query: RateLimitQuery): Promise<RateLimitVerdict> {
  if (!env.RATE_LIMITER) return checkRateLimitLocally(query);

  // Shard on the first two characters of the (already hashed) key.
  const shard = query.key.slice(0, 2);
  const id = env.RATE_LIMITER.idFromName(`${projectId}:${shard}`);
  const stub = env.RATE_LIMITER.get(id);

  try {
    const response = await stub.fetch('https://rate-limiter.internal/check', {
      method: 'POST',
      body: JSON.stringify(query),
    });
    if (!response.ok) return checkRateLimitLocally(query);
    return (await response.json()) as RateLimitVerdict;
  } catch (error) {
    // Never fail a customer's request because our counter was unreachable.
    console.error('rate limiter unavailable', error);
    return checkRateLimitLocally(query);
  }
}

async function evaluateRateLimit(
  context: RequestContext,
  config: EdgeProjectConfig,
  env: Env,
  ipHash: string,
): Promise<{ reasons: DecisionReason[]; retryAfterSeconds: number }> {
  if (!config.rateLimit.enabled) return { reasons: [], retryAfterSeconds: 0 };

  const verdict = await queryRateLimiter(env, config.projectId, {
    key: ipHash,
    limit: config.rateLimit.requestsPerMinute,
    windowMs: 60_000,
    burst: config.rateLimit.burst,
    banSeconds: config.rateLimit.banSeconds,
    now: context.startedAt,
  });

  if (!verdict.limited) return { reasons: [], retryAfterSeconds: 0 };

  return {
    retryAfterSeconds: verdict.retryAfterSeconds,
    reasons: [
      {
        layer: 'ratelimit',
        ruleId: 'rate.exceeded',
        description: `Client sent approximately ${verdict.observed} requests in 60 seconds, against a configured ceiling of ${config.rateLimit.requestsPerMinute}`,
        action: 'block',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Authorisation boundary (CFAA layer)
// ---------------------------------------------------------------------------

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function evaluateAuthGate(
  context: RequestContext,
  config: EdgeProjectConfig,
): Promise<DecisionReason[]> {
  if (!config.authGate.enabled) return [];

  const route = findProtectedRoute(context.path, config.authGate.routes);
  if (!route) return [];

  const label = route.label ? `"${route.label}"` : route.pattern;
  const deny = (ruleId: string, description: string): DecisionReason[] => [
    { layer: 'authgate', ruleId, description, action: 'block' },
  ];

  switch (route.mode) {
    case 'deny':
      return deny(
        'gate.deny',
        `Request targeted ${label}, a route the site owner has closed to all external access`,
      );

    case 'session': {
      const session = context.cookies.get(config.authGate.authCookieName);
      if (session && session.length > 0) return [];
      return deny(
        'gate.no_session',
        `Request targeted ${label}, which requires a signed-in session, and carried no "${config.authGate.authCookieName}" session cookie`,
      );
    }

    case 'apikey': {
      const presented = context.request.headers.get('x-fs-key');
      if (!presented) {
        return deny('gate.no_api_key', `Request targeted ${label}, which requires an issued API key, and presented none`);
      }
      const digest = await sha256Hex(presented);
      if ((route.keyHashes ?? []).includes(digest)) return [];
      return deny(
        'gate.bad_api_key',
        `Request targeted ${label} presenting an API key that has never been issued for this site`,
      );
    }

    case 'ip_allowlist': {
      if (ipInAny(context.ip, route.cidrs ?? [])) return [];
      return deny(
        'gate.ip_not_allowed',
        `Request targeted ${label}, which is restricted to specific networks, from the unlisted address ${context.ip}`,
      );
    }

    case 'clickwrap': {
      const accepted = await verifyClickwrap({
        value: context.cookies.get(CLICKWRAP_COOKIE),
        tpmSecret: config.tpmSecret,
        domain: config.domain,
        nowMs: context.startedAt,
        requiredVersion: config.clickwrap.version,
      });
      if (accepted.ok) return [];
      return deny(
        'gate.no_acceptance',
        `Request targeted ${label} without having accepted version ${config.clickwrap.version} of the site's terms`,
      );
    }

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Clickwrap (site-wide)
// ---------------------------------------------------------------------------

async function evaluateClickwrap(context: RequestContext, config: EdgeProjectConfig): Promise<DecisionReason[]> {
  if (!config.clickwrap.enabled) return [];

  const paths = config.clickwrap.requiredPaths;
  if (paths.length > 0 && !matchesAny(context.path, paths)) return [];

  const accepted = await verifyClickwrap({
    value: context.cookies.get(CLICKWRAP_COOKIE),
    tpmSecret: config.tpmSecret,
    domain: config.domain,
    nowMs: context.startedAt,
    requiredVersion: config.clickwrap.version,
  });
  if (accepted.ok) return [];

  return [
    {
      layer: 'clickwrap',
      ruleId: 'clickwrap.not_accepted',
      description: `Request proceeded without accepting version ${config.clickwrap.version} of the site's terms of use`,
      action: 'challenge',
    },
  ];
}

// ---------------------------------------------------------------------------
// Technological protection measure (DMCA 1201 layer)
// ---------------------------------------------------------------------------

/** Whether this specific request has to carry a valid token. */
export function tpmRequiredFor(context: RequestContext, config: EdgeProjectConfig): boolean {
  if (!config.tpm.enabled) return false;
  if (matchesAny(context.path, config.tpm.exemptPaths)) return false;
  if (matchesAny(context.path, config.tpm.protectPaths)) return true;
  if (config.mode === 'strict') return true;
  // In `standard` mode the HTML document is served so the challenge can load;
  // everything the document then asks for must be authorised.
  if (config.mode === 'standard') return !context.isDocumentRequest;
  return false;
}

async function evaluateTpm(
  context: RequestContext,
  config: EdgeProjectConfig,
): Promise<{ reasons: DecisionReason[]; claims: TokenClaims | null }> {
  if (!config.tpm.enabled) return { reasons: [], claims: null };

  const presented =
    context.cookies.get(TOKEN_COOKIE) ?? context.request.headers.get(TOKEN_HEADER) ?? null;

  const result = await verifyToken({
    token: presented,
    tpmSecret: config.tpmSecret,
    domain: config.domain,
    nowMs: context.startedAt,
    epochSeconds: config.tpm.epochSeconds,
    binding: bindingFor(context, config),
  });

  if (result.ok) return { reasons: [], claims: result.claims };
  if (!tpmRequiredFor(context, config)) return { reasons: [], claims: null };

  // A token that is merely absent or stale means "has not solved the challenge
  // yet" — recoverable. A token that is present but does not verify means
  // somebody constructed one, which is a materially different fact.
  const recoverable = result.reason === 'missing' || result.reason === 'expired' || result.reason === 'stale_epoch';

  const descriptions: Record<typeof result.reason, string> = {
    missing: 'Request carried no access token, so the client had not completed the browser verification challenge',
    expired: 'Request carried an access token that had passed its expiry time',
    stale_epoch: 'Request carried an access token signed with a key that had already been rotated out',
    malformed: 'Request carried a value in the access-token position that was not a token at all',
    unknown_version: 'Request carried an access token in a format this site does not issue',
    bad_signature:
      'Request carried an access token whose signature did not verify — the token was constructed rather than issued by this site',
    binding_mismatch:
      'Request carried a valid access token that had been issued to a different client, indicating the token was copied out of the browser it was issued to',
  };

  return {
    claims: null,
    reasons: [
      {
        layer: 'tpm',
        ruleId: `tpm.${result.reason}`,
        description: descriptions[result.reason],
        action: recoverable ? 'challenge' : 'block',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function assess(
  context: RequestContext,
  config: EdgeProjectConfig,
  env: Env,
): Promise<Assessment> {
  const ipHash = await hashIp(context.ip, config);
  const reasons: DecisionReason[] = [];

  const lists = evaluateAccessLists(context, config);
  reasons.push(...lists.reasons);
  if (lists.terminal) {
    return { reasons, botScore: 0, tokenClaims: null, allowlisted: reasons.length === 0, retryAfterSeconds: 0, ipHash };
  }

  const bots = evaluateBots(context, config);
  reasons.push(...bots.reasons);
  if (bots.terminal) {
    return { reasons, botScore: bots.score, tokenClaims: null, allowlisted: true, retryAfterSeconds: 0, ipHash };
  }

  const rate = await evaluateRateLimit(context, config, env, ipHash);
  reasons.push(...rate.reasons);

  const gate = await evaluateAuthGate(context, config);
  reasons.push(...gate);

  const clickwrap = await evaluateClickwrap(context, config);
  reasons.push(...clickwrap);

  const tpm = await evaluateTpm(context, config);
  reasons.push(...tpm.reasons);

  return {
    reasons,
    botScore: bots.score,
    tokenClaims: tpm.claims,
    allowlisted: false,
    retryAfterSeconds: rate.retryAfterSeconds,
    ipHash,
  };
}
