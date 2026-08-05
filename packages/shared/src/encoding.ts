/**
 * Cross-runtime encoding helpers.
 *
 * Everything here works identically in Node >= 20, Cloudflare Workers and the
 * browser. We deliberately avoid `Buffer` so the same module can be bundled
 * into the edge worker without a Node polyfill.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(input: string): Uint8Array {
  return encoder.encode(input);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function bytesToB64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked to avoid blowing the argument limit on large inputs.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64UrlToBytes(input: string): Uint8Array {
  const normalised = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalised.length % 4 === 0 ? '' : '='.repeat(4 - (normalised.length % 4));
  const binary = atob(normalised + padding);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeJson(value: unknown): string {
  return bytesToB64Url(utf8(JSON.stringify(value)));
}

/** Returns `null` instead of throwing so callers can treat bad input as "untrusted". */
export function decodeJson<T>(segment: string): T | null {
  try {
    return JSON.parse(fromUtf8(b64UrlToBytes(segment))) as T;
  } catch {
    return null;
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Number of leading zero *bits* — the proof-of-work difficulty measure. */
export function leadingZeroBits(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    count += Math.clz32(byte) - 24;
    break;
  }
  return count;
}
