import { bytesToB64Url, hmacSha256, utf8, type BindingInput, type EdgeProjectConfig } from '@foundershield/shared';

/**
 * Everything the layers are allowed to know about a request, resolved once so
 * no layer re-parses headers. Fields mirror the evidence record: if it is not
 * here, it does not end up in an exhibit.
 */
export interface RequestContext {
  request: Request;
  url: URL;
  host: string;
  path: string;
  method: string;
  ip: string;
  userAgent: string;
  referer: string | null;
  country: string | null;
  asn: number | null;
  asOrganisation: string | null;
  edgeLocation: string | null;
  requestId: string | null;
  tlsVersion: string | null;
  verifiedBotCategory: string | null;
  cookies: Map<string, string>;
  /** True when the client asked for an HTML document (not XHR/asset). */
  isDocumentRequest: boolean;
  startedAt: number;
}

interface CloudflareProperties {
  asn?: number;
  asOrganization?: string;
  colo?: string;
  country?: string;
  tlsVersion?: string;
  verifiedBotCategory?: string;
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name) out.set(name, value);
  }
  return out;
}

function looksLikeDocument(request: Request, accept: string | null): boolean {
  const dest = request.headers.get('sec-fetch-dest');
  if (dest) return dest === 'document' || dest === 'iframe';
  // Older clients: fall back to the Accept header.
  return Boolean(accept && accept.includes('text/html'));
}

export function buildContext(request: Request, nowMs: number): RequestContext {
  const url = new URL(request.url);
  const cf = (request as Request & { cf?: CloudflareProperties }).cf ?? {};
  const accept = request.headers.get('accept');

  return {
    request,
    url,
    host: url.hostname.toLowerCase(),
    path: url.pathname,
    method: request.method.toUpperCase(),
    ip:
      request.headers.get('cf-connecting-ip') ??
      request.headers.get('x-real-ip') ??
      (request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ??
      '0.0.0.0',
    userAgent: request.headers.get('user-agent') ?? '',
    referer: request.headers.get('referer'),
    country: cf.country ?? null,
    asn: typeof cf.asn === 'number' ? cf.asn : null,
    asOrganisation: cf.asOrganization ?? null,
    edgeLocation: cf.colo ?? null,
    requestId: request.headers.get('cf-ray'),
    tlsVersion: cf.tlsVersion ?? null,
    verifiedBotCategory: cf.verifiedBotCategory ?? null,
    cookies: parseCookies(request.headers.get('cookie')),
    isDocumentRequest: looksLikeDocument(request, accept),
    startedAt: nowMs,
  };
}

export function bindingFor(context: RequestContext, config: EdgeProjectConfig): BindingInput {
  return {
    ip: context.ip,
    userAgent: context.userAgent,
    bindIp: config.tpm.bindIp,
    bindUserAgent: config.tpm.bindUserAgent,
  };
}

/**
 * Pseudonymous, per-project IP identifier. Keyed by the project secret so the
 * same visitor cannot be correlated across two different customers' sites.
 */
export async function hashIp(ip: string, config: EdgeProjectConfig): Promise<string> {
  const digest = await hmacSha256(utf8(config.tpmSecret), utf8(`ip:${ip}`));
  return bytesToB64Url(digest.subarray(0, 12));
}
