/**
 * The proxy's own endpoints, all under `/__fs/v1/`.
 *
 * This prefix is reserved: it is never forwarded to the origin, so a customer
 * application can never be shadowed by it and can never impersonate it.
 */

import {
  CLICKWRAP_COOKIE,
  TOKEN_COOKIE,
  constantTimeEqual,
  issueChallenge,
  issueClickwrap,
  issueToken,
  utf8,
  verifyChallengeSolution,
  type EdgeProjectConfig,
} from '@foundershield/shared';
import { bindingFor, hashIp, type RequestContext } from './context.js';
import { purgeConfig } from './config-store.js';
import { clientScriptResponse } from './proxy.js';
import { recordEvent } from './logging.js';
import type { Env } from './env.js';

export const INTERNAL_PREFIX = '/__fs/v1';

const NO_STORE = { 'cache-control': 'no-store', 'x-foundershield': 'active' } as const;

function cookieAttributes(context: RequestContext, maxAgeSeconds: number): string {
  const secure = context.url.protocol === 'https:' ? '; Secure' : '';
  return `Path=/; Max-Age=${maxAgeSeconds}; HttpOnly${secure}; SameSite=Lax`;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...(init.headers ?? {}) },
  });
}

/** Safe redirect target: same-origin paths only, never an absolute URL. */
function safePath(candidate: unknown): string {
  if (typeof candidate !== 'string' || candidate.length === 0) return '/';
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  return candidate;
}

export async function handleInternal(
  context: RequestContext,
  config: EdgeProjectConfig | null,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const route = context.path.slice(INTERNAL_PREFIX.length) || '/';

  // Served before config resolution so it works on an unconfigured hostname.
  if (route === '/c.js') return clientScriptResponse();

  if (route === '/health') {
    return json(
      {
        ok: true,
        service: 'foundershield-edge',
        configured: Boolean(config),
        project: config?.projectId ?? null,
        status: config?.status ?? null,
        mode: config?.mode ?? null,
        edgeLocation: context.edgeLocation,
      },
      { headers: { 'x-foundershield': config ? 'active' : 'unconfigured' } },
    );
  }

  if (route === '/admin/purge') {
    if (context.method !== 'POST') return json({ error: 'method_not_allowed' }, { status: 405 });

    const presented = context.request.headers.get('x-fs-admin-key') ?? '';
    const expected = env.FS_ADMIN_KEY ?? '';
    if (!expected || !constantTimeEqual(utf8(presented), utf8(expected))) {
      return json({ error: 'unauthorized' }, { status: 401 });
    }

    const body = (await context.request.json().catch(() => ({}))) as { domain?: string };
    const domain = typeof body.domain === 'string' ? body.domain.toLowerCase() : context.host;
    await purgeConfig(env, domain);
    return json({ ok: true, purged: domain });
  }

  if (!config) return json({ error: 'domain_not_configured' }, { status: 503 });

  if (route === '/challenge') {
    const challenge = await issueChallenge({
      tpmSecret: config.tpmSecret,
      domain: config.domain,
      nowMs: context.startedAt,
      epochSeconds: config.tpm.epochSeconds,
      difficulty: config.tpm.difficulty,
      binding: bindingFor(context, config),
    });

    return json({
      cid: challenge.cid,
      salt: challenge.salt,
      difficulty: challenge.difficulty,
      expiresAt: challenge.expiresAt,
    });
  }

  if (route === '/verify') {
    if (context.method !== 'POST') return json({ error: 'method_not_allowed' }, { status: 405 });

    const body = (await context.request.json().catch(() => null)) as {
      cid?: string;
      nonce?: string;
      signals?: Record<string, unknown>;
    } | null;

    if (!body?.cid || typeof body.nonce !== 'string') {
      return json({ ok: false, error: 'malformed_solution' }, { status: 400 });
    }

    const result = await verifyChallengeSolution({
      cid: body.cid,
      nonce: body.nonce,
      tpmSecret: config.tpmSecret,
      domain: config.domain,
      nowMs: context.startedAt,
      epochSeconds: config.tpm.epochSeconds,
      binding: bindingFor(context, config),
    });

    const ipHash = await hashIp(context.ip, config);

    if (!result.ok) {
      recordEvent(env, ctx, context, config, {
        action: 'block',
        enforced: true,
        reasons: [
          {
            layer: 'tpm',
            ruleId: `challenge.${result.reason}`,
            description: `A challenge solution was submitted that did not verify (${result.reason})`,
            action: 'block',
          },
        ],
        botScore: 100,
        sessionId: null,
        responseStatus: 403,
        originMs: null,
        responseBytes: null,
        ipHash,
        signals: body.signals,
      });
      return json({ ok: false, error: result.reason }, { status: 403 });
    }

    // The browser told us it is under automation control. In strict mode we
    // take it at its word; otherwise we issue the token and record the fact,
    // so a customer's own end-to-end tests keep working.
    const declaredWebdriver = body.signals?.wd === true;
    if (declaredWebdriver && config.mode === 'strict') {
      recordEvent(env, ctx, context, config, {
        action: 'block',
        enforced: true,
        reasons: [
          {
            layer: 'tpm',
            ruleId: 'challenge.webdriver',
            description:
              'The browser reported navigator.webdriver = true, meaning it was being driven by an automation framework rather than by a person',
            action: 'block',
          },
        ],
        botScore: 95,
        sessionId: null,
        responseStatus: 403,
        originMs: null,
        responseBytes: null,
        ipHash,
        signals: body.signals,
      });
      return json({ ok: false, error: 'automation_detected' }, { status: 403 });
    }

    const { token, claims } = await issueToken({
      tpmSecret: config.tpmSecret,
      domain: config.domain,
      nowMs: context.startedAt,
      epochSeconds: config.tpm.epochSeconds,
      ttlSeconds: config.tpm.ttlSeconds,
      level: 'pow',
      binding: bindingFor(context, config),
    });

    if (declaredWebdriver) {
      recordEvent(env, ctx, context, config, {
        action: 'allow',
        enforced: true,
        reasons: [
          {
            layer: 'tpm',
            ruleId: 'challenge.webdriver_permitted',
            description:
              'The browser reported navigator.webdriver = true; a token was issued because this site is not in strict mode',
            action: 'allow',
          },
        ],
        botScore: 95,
        sessionId: claims.sid,
        responseStatus: 200,
        originMs: null,
        responseBytes: null,
        ipHash,
        signals: body.signals,
      });
    }

    return json(
      { ok: true, expiresIn: config.tpm.ttlSeconds, sessionId: claims.sid },
      { headers: { 'set-cookie': `${TOKEN_COOKIE}=${token}; ${cookieAttributes(context, config.tpm.ttlSeconds)}` } },
    );
  }

  if (route === '/clickwrap') {
    if (context.method !== 'POST') return json({ error: 'method_not_allowed' }, { status: 405 });

    const contentType = context.request.headers.get('content-type') ?? '';
    let returnTo = '/';
    let version = config.clickwrap.version;

    if (contentType.includes('application/json')) {
      const body = (await context.request.json().catch(() => ({}))) as Record<string, unknown>;
      returnTo = safePath(body.returnTo);
      if (typeof body.version === 'string') version = body.version;
    } else {
      const form = await context.request.formData().catch(() => null);
      returnTo = safePath(form?.get('returnTo'));
      const submitted = form?.get('version');
      if (typeof submitted === 'string') version = submitted;
    }

    // Never let the client choose which version it is agreeing to.
    if (version !== config.clickwrap.version) {
      return json({ ok: false, error: 'stale_terms_version' }, { status: 409 });
    }

    const ttlSeconds = 60 * 60 * 24 * 365;
    const value = await issueClickwrap({
      tpmSecret: config.tpmSecret,
      domain: config.domain,
      nowMs: context.startedAt,
      ttlSeconds,
      version: config.clickwrap.version,
      binding: bindingFor(context, config),
    });

    recordEvent(env, ctx, context, config, {
      action: 'allow',
      enforced: true,
      reasons: [
        {
          layer: 'clickwrap',
          ruleId: 'clickwrap.accepted',
          description: `Visitor affirmatively accepted version ${config.clickwrap.version} of the site's terms of use by clicking "I agree"`,
          action: 'allow',
        },
      ],
      botScore: 0,
      sessionId: null,
      responseStatus: 303,
      originMs: null,
      responseBytes: null,
      ipHash: await hashIp(context.ip, config),
    });

    return new Response(null, {
      status: 303,
      headers: {
        location: returnTo,
        'set-cookie': `${CLICKWRAP_COOKIE}=${value}; ${cookieAttributes(context, ttlSeconds)}`,
        ...NO_STORE,
      },
    });
  }

  return json({ error: 'not_found' }, { status: 404 });
}
