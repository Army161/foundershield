/**
 * Path pattern matching for protected routes and TPM path lists.
 *
 * Syntax (deliberately small — a founder types these into a text box):
 *   /api/private        exact match
 *   /api/*              one path segment
 *   /admin/**           any depth, including zero
 *   *.json              suffix match within a segment
 */

import type { ProtectedRoute } from './config';

/**
 * Placeholder standing in for `**` while single `*` is rewritten. Uses a
 * character that can never survive URL parsing in a pathname.
 */
const DOUBLE_STAR = String.fromCharCode(1);

const compiled = new Map<string, RegExp>();

export function patternToRegExp(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached) return cached;

  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  const body = escaped
    .split('**')
    .join(DOUBLE_STAR)
    .replace(/\*/g, '[^/]*')
    // `/admin/**` should also match `/admin` itself, not just its children.
    .split(`/${DOUBLE_STAR}`)
    .join('(?:/.*)?')
    .split(DOUBLE_STAR)
    .join('.*');

  // Trailing slash is insignificant.
  const regex = new RegExp(`^${body}/?$`, 'i');
  if (compiled.size < 5000) compiled.set(pattern, regex);
  return regex;
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (patternToRegExp(pattern).test(path)) return true;
  }
  return false;
}

export function findProtectedRoute(path: string, routes: readonly ProtectedRoute[]): ProtectedRoute | null {
  for (const route of routes) {
    if (!route.enabled) continue;
    if (patternToRegExp(route.pattern).test(path)) return route;
  }
  return null;
}

/**
 * Minimal CIDR matcher for IPv4 and IPv6. A bare address (no `/`) is treated as
 * a /32 or /128. Returns false rather than throwing on malformed input.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  if (!range) return false;

  const ipBytes = parseIp(ip);
  const rangeBytes = parseIp(range);
  if (!ipBytes || !rangeBytes || ipBytes.length !== rangeBytes.length) return false;

  const maxBits = ipBytes.length * 8;
  const bits = bitsRaw === undefined ? maxBits : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return false;

  const fullBytes = bits >> 3;
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== rangeBytes[i]) return false;
  }
  const remainder = bits & 7;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((ipBytes[fullBytes] as number) & mask) === ((rangeBytes[fullBytes] as number) & mask);
}

export function ipInAny(ip: string, cidrs: readonly string[]): boolean {
  for (const cidr of cidrs) {
    if (ipInCidr(ip, cidr)) return true;
  }
  return false;
}

function parseIp(value: string): Uint8Array | null {
  const trimmed = value.trim();
  if (trimmed.includes(':')) return parseIpv6(trimmed);
  return parseIpv4(trimmed);
}

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i] as string;
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(value: string): Uint8Array | null {
  // Strip a zone index (fe80::1%eth0) if present.
  const address = value.split('%')[0] ?? value;
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const expand = (segment: string): string[] => (segment.length === 0 ? [] : segment.split(':'));
  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : [];

  const groups: string[] = [];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups.push(...head, ...Array<string>(fill).fill('0'), ...tail);
  } else {
    groups.push(...head);
  }
  if (groups.length !== 8) return null;

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i] as string;
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const n = parseInt(group, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}
