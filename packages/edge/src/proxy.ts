/**
 * Origin forwarding.
 *
 * The proxy is intentionally conservative: it rewrites the minimum needed to
 * reach the origin, forwards the client's real address, and otherwise gets out
 * of the way. Anything clever here shows up as a broken customer site.
 */

import type { EdgeProjectConfig } from '@foundershield/shared';
import type { RequestContext } from './context.js';
import { CLIENT_SCRIPT } from './challenge/client-script.js';

/** Headers that describe a single hop and must not be relayed. */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

export interface OriginResult {
  response: Response;
  originMs: number;
}

export async function fetchFromOrigin(
  context: RequestContext,
  config: EdgeProjectConfig,
  tokenVerified: boolean,
): Promise<OriginResult> {
  const origin = new URL(config.originUrl);
  const target = new URL(context.url.toString());
  target.protocol = origin.protocol;
  target.hostname = origin.hostname;
  target.port = origin.port;

  // Preserve any path prefix the customer configured on the origin URL.
  const basePath = origin.pathname.replace(/\/$/, '');
  if (basePath) target.pathname = basePath + target.pathname;

  const headers = new Headers(context.request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);

  // Strip our own cookies so the customer's app never sees proxy internals.
  const cookie = headers.get('cookie');
  if (cookie) {
    const kept = cookie
      .split(';')
      .filter((pair) => !pair.trim().startsWith('__fs_'))
      .join(';')
      .trim();
    if (kept) headers.set('cookie', kept);
    else headers.delete('cookie');
  }

  headers.set('x-forwarded-for', context.ip);
  headers.set('x-forwarded-proto', context.url.protocol.replace(':', ''));
  headers.set('x-forwarded-host', context.host);
  headers.set('x-real-ip', context.ip);

  // Let the customer's application make its own decisions with what we learned.
  headers.set('x-foundershield-project', config.projectId);
  headers.set('x-foundershield-verified', tokenVerified ? '1' : '0');
  if (context.country) headers.set('x-foundershield-country', context.country);
  if (context.requestId) headers.set('x-foundershield-request-id', context.requestId);

  const startedAt = Date.now();
  const response = await fetch(target.toString(), {
    method: context.request.method,
    headers,
    body: context.request.body,
    redirect: 'manual',
  });

  return { response, originMs: Date.now() - startedAt };
}

/**
 * Rewrite the origin's response on its way back out.
 *
 * The challenge is added as a same-origin `<script src>` rather than an inline
 * block so it satisfies a `script-src 'self'` policy untouched. When the origin
 * ships a stricter CSP that names hosts explicitly, we add `'self'` to it —
 * loosening a policy is unpleasant, but silently breaking the protection layer
 * is worse, and this is the narrowest possible widening.
 */
export function prepareResponse(
  origin: Response,
  options: { injectChallenge: boolean; verified: boolean },
): Response {
  const headers = new Headers(origin.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  headers.set('x-foundershield', 'active');

  const contentType = headers.get('content-type') ?? '';
  const isHtml = contentType.includes('text/html');

  if (!options.injectChallenge || !isHtml) {
    return new Response(origin.body, { status: origin.status, statusText: origin.statusText, headers });
  }

  const csp = headers.get('content-security-policy');
  if (csp && /script-src/i.test(csp) && !/script-src[^;]*'self'/i.test(csp)) {
    headers.set('content-security-policy', csp.replace(/script-src/i, "script-src 'self'"));
  }

  const rewriter = new HTMLRewriter().on('head', {
    element(element) {
      element.append('<script src="/__fs/v1/c.js" defer></script>', { html: true });
    },
  });

  const response = new Response(origin.body, {
    status: origin.status,
    statusText: origin.statusText,
    headers,
  });
  return rewriter.transform(response);
}

export function clientScriptResponse(): Response {
  return new Response(CLIENT_SCRIPT, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      // Long cache is safe: the script has no embedded per-site state.
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
      'x-foundershield': 'challenge-client',
    },
  });
}
