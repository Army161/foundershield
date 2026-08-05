/**
 * FounderShield edge proxy.
 *
 * Request lifecycle:
 *   build context -> resolve policy -> internal routes -> assess -> act -> log
 *
 * Two invariants hold throughout:
 *   - An error inside FounderShield must never take a customer's site down. Any
 *     unexpected throw falls through to a plain pass-through proxy.
 *   - Every enforcement decision is recorded before the response is returned.
 */

import { resolveDecision, matchesAny } from '@foundershield/shared';
import { buildContext, type RequestContext } from './context.js';
import { loadConfig } from './config-store.js';
import { handleInternal, INTERNAL_PREFIX } from './endpoints.js';
import { assess, tpmRequiredFor } from './layers.js';
import { recordEvent } from './logging.js';
import { blockedPage, clickwrapPage, interstitialPage, rateLimitedPage } from './pages.js';
import { fetchFromOrigin, prepareResponse } from './proxy.js';
import type { Env } from './env.js';

export { RateLimiterDurableObject } from './durable/rate-limiter.js';

function wantsHtml(context: RequestContext): boolean {
  return context.isDocumentRequest || (context.request.headers.get('accept') ?? '').includes('text/html');
}

function unconfiguredResponse(host: string): Response {
  return new Response(
    JSON.stringify({
      error: 'domain_not_configured',
      message: `${host} is not configured on this FounderShield deployment. Add it in the dashboard, then re-check DNS.`,
    }),
    { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  );
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const context = buildContext(request, Date.now());
  const config = await loadConfig(env, context.host, ctx, context.startedAt);

  if (context.path === INTERNAL_PREFIX || context.path.startsWith(`${INTERNAL_PREFIX}/`)) {
    const response = await handleInternal(context, config, env, ctx);
    if (response) return response;
  }

  if (!config) return unconfiguredResponse(context.host);

  // A project that is not live yet, or deliberately paused, is a plain proxy.
  if (config.status !== 'active') {
    const { response } = await fetchFromOrigin(context, config, false);
    return prepareResponse(response, { injectChallenge: false, verified: false });
  }

  const assessment = await assess(context, config, env);
  const resolved = resolveDecision(assessment.reasons);

  // `monitor` records exactly what would have happened and enforces nothing.
  const enforced = config.mode === 'monitor' ? 'allow' : resolved.action;

  if (enforced === 'block') {
    const rateLimited = resolved.primary?.layer === 'ratelimit';
    const status = rateLimited ? 429 : 403;
    const html = wantsHtml(context);

    const body = html
      ? rateLimited
        ? rateLimitedPage(assessment.retryAfterSeconds, context.requestId)
        : blockedPage(assessment.reasons, context.requestId)
      : JSON.stringify({
          error: rateLimited ? 'rate_limited' : 'forbidden',
          reason: resolved.primary?.ruleId ?? 'blocked',
          requestId: context.requestId,
        });

    const headers: Record<string, string> = {
      'content-type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-foundershield': 'blocked',
    };
    if (rateLimited) headers['retry-after'] = String(assessment.retryAfterSeconds);

    recordEvent(env, ctx, context, config, {
      action: 'block',
      enforced: true,
      reasons: assessment.reasons,
      botScore: assessment.botScore,
      sessionId: assessment.tokenClaims?.sid ?? null,
      responseStatus: status,
      originMs: null,
      responseBytes: body.length,
      ipHash: assessment.ipHash,
    });

    return new Response(body, { status, headers });
  }

  if (enforced === 'challenge') {
    const needsClickwrap = resolved.primary?.layer === 'clickwrap';
    const html = wantsHtml(context);

    if (html) {
      const returnTo = context.url.pathname + context.url.search;
      const body = needsClickwrap
        ? clickwrapPage({
            returnTo,
            tosUrl: config.clickwrap.tosUrl,
            version: config.clickwrap.version,
            siteName: config.domain,
          })
        : interstitialPage(returnTo);

      recordEvent(env, ctx, context, config, {
        action: 'challenge',
        enforced: true,
        reasons: assessment.reasons,
        botScore: assessment.botScore,
        sessionId: null,
        responseStatus: 401,
        originMs: null,
        responseBytes: body.length,
        ipHash: assessment.ipHash,
      });

      return new Response(body, {
        status: 401,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-foundershield': 'challenge',
        },
      });
    }

    // A subresource or API call cannot render an interstitial. Signal the
    // client script, which re-verifies and replays the request transparently.
    const body = JSON.stringify({ error: 'challenge_required', requestId: context.requestId });
    recordEvent(env, ctx, context, config, {
      action: 'challenge',
      enforced: true,
      reasons: assessment.reasons,
      botScore: assessment.botScore,
      sessionId: null,
      responseStatus: 403,
      originMs: null,
      responseBytes: body.length,
      ipHash: assessment.ipHash,
    });

    return new Response(body, {
      status: 403,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-fs-challenge': 'required',
        'x-foundershield': 'challenge',
      },
    });
  }

  const verified = assessment.tokenClaims !== null;
  const { response, originMs } = await fetchFromOrigin(context, config, verified);

  // Only inject where the challenge is actually needed and can actually run.
  const injectChallenge =
    config.tpm.enabled &&
    !assessment.allowlisted &&
    !verified &&
    !matchesAny(context.path, config.tpm.exemptPaths);

  const prepared = prepareResponse(response, { injectChallenge, verified });

  // In monitor mode the recorded action is what the policy *decided*; `enforced`
  // is what actually happened. Keeping both is what makes a monitor-mode dry run
  // readable before a customer turns enforcement on.
  recordEvent(env, ctx, context, config, {
    action: resolved.action,
    enforced: resolved.action === 'allow',
    reasons: assessment.reasons,
    botScore: assessment.botScore,
    sessionId: assessment.tokenClaims?.sid ?? null,
    responseStatus: prepared.status,
    originMs,
    responseBytes: Number(prepared.headers.get('content-length')) || null,
    ipHash: assessment.ipHash,
  });

  return prepared;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      console.error('unhandled edge error', error);

      // Fail open. A bug in the protection layer must not be an outage for the
      // customer's users — the alternative trades their availability for our
      // correctness, which is not a trade we get to make on their behalf.
      try {
        const context = buildContext(request, Date.now());
        const config = await loadConfig(env, context.host, ctx, context.startedAt);
        if (config) {
          const { response } = await fetchFromOrigin(context, config, false);
          const headers = new Headers(response.headers);
          headers.set('x-foundershield', 'degraded');
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        }
      } catch (fallbackError) {
        console.error('fallback proxy failed', fallbackError);
      }

      return new Response('Bad gateway', { status: 502, headers: { 'x-foundershield': 'error' } });
    }
  },
};
