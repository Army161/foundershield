/**
 * The DMCA §1201 "technological protection measure" itself.
 *
 * Two artefacts live here:
 *
 *   Challenge (`fc1.…`)  — issued by the edge, stateless. Carries a salt, an
 *                          expiry, a difficulty and a client binding, all under
 *                          an HMAC keyed by the *current rolling epoch key*.
 *   Token     (`fs1.…`)  — issued once a client returns a valid proof-of-work
 *                          for a challenge. Presented on every later request.
 *
 * Both are stateless: the edge stores nothing per session, which is what lets
 * this run at the edge with no origin round-trip. Access control comes from the
 * fact that only a client that actually executed the challenge program can
 * produce a value that verifies.
 */

import { bindingHash, constantTimeEqual, deriveEpochKey, epochFor, hmacSha256, randomBytes, sha256 } from './crypto';
import { b64UrlToBytes, bytesToB64Url, decodeJson, encodeJson, leadingZeroBits, utf8 } from './encoding';

export const TOKEN_PREFIX = 'fs1';
export const CHALLENGE_PREFIX = 'fc1';
export const TOKEN_COOKIE = '__fs_tk';
export const CLICKWRAP_COOKIE = '__fs_cw';
export const TOKEN_HEADER = 'x-fs-token';

export type TokenLevel = 'pow' | 'clickwrap' | 'api';

export interface TokenClaims {
  /** Schema version. */
  v: 1;
  /** Rolling epoch this token was signed under. */
  ep: number;
  /** Opaque session id — correlates evidence-log rows without identifying a person. */
  sid: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. */
  exp: number;
  lvl: TokenLevel;
  /** base64url binding hash over the client attributes the policy pins. */
  bind: string;
  /** Clickwrap version the holder accepted, if any. */
  cw?: string;
}

export interface ChallengeClaims {
  v: 1;
  ep: number;
  exp: number;
  /** Difficulty in leading zero bits. */
  d: number;
  /** Proof-of-work salt. */
  s: string;
  bind: string;
}

export interface BindingInput {
  ip: string;
  userAgent: string;
  bindIp: boolean;
  bindUserAgent: boolean;
}

export type TokenFailure =
  | 'missing'
  | 'malformed'
  | 'unknown_version'
  | 'stale_epoch'
  | 'bad_signature'
  | 'expired'
  | 'binding_mismatch';

export type VerifyResult<T> = { ok: true; claims: T } | { ok: false; reason: TokenFailure };

function secretBytes(tpmSecret: string): Uint8Array {
  return b64UrlToBytes(tpmSecret);
}

export function generateSecret(): string {
  return bytesToB64Url(randomBytes(32));
}

async function computeBinding(input: BindingInput, secret: Uint8Array): Promise<string> {
  const parts: string[] = [];
  parts.push(input.bindIp ? input.ip : '-');
  parts.push(input.bindUserAgent ? input.userAgent : '-');
  return bytesToB64Url(await bindingHash(parts, secret));
}

async function sign(body: string, secret: Uint8Array, domain: string, epoch: number): Promise<string> {
  const key = await deriveEpochKey(secret, domain, epoch);
  return bytesToB64Url(await hmacSha256(key, utf8(body)));
}

/**
 * Verify `prefix.payload.signature`, accepting the current epoch and the one
 * before it so a token minted moments before a rotation still works.
 */
async function verifyEnvelope<T extends { ep: number; exp: number }>(
  value: string,
  prefix: string,
  tpmSecret: string,
  domain: string,
  nowMs: number,
  epochSeconds: number,
): Promise<VerifyResult<T>> {
  const parts = value.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [gotPrefix, payload, signature] = parts as [string, string, string];
  if (gotPrefix !== prefix) return { ok: false, reason: 'unknown_version' };

  const claims = decodeJson<T>(payload);
  if (!claims || typeof claims.ep !== 'number' || typeof claims.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }

  const current = epochFor(nowMs, epochSeconds);
  if (claims.ep !== current && claims.ep !== current - 1) {
    return { ok: false, reason: 'stale_epoch' };
  }

  const expected = await sign(`${gotPrefix}.${payload}`, secretBytes(tpmSecret), domain, claims.ep);
  if (!constantTimeEqual(b64UrlToBytes(expected), b64UrlToBytes(signature))) {
    return { ok: false, reason: 'bad_signature' };
  }

  if (claims.exp * 1000 <= nowMs) return { ok: false, reason: 'expired' };

  return { ok: true, claims };
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

export interface IssueChallengeInput {
  tpmSecret: string;
  domain: string;
  nowMs: number;
  epochSeconds: number;
  difficulty: number;
  /** How long the client has to solve it. */
  ttlSeconds?: number;
  binding: BindingInput;
}

export interface IssuedChallenge {
  cid: string;
  salt: string;
  difficulty: number;
  expiresAt: number;
}

export async function issueChallenge(input: IssueChallengeInput): Promise<IssuedChallenge> {
  const secret = secretBytes(input.tpmSecret);
  const epoch = epochFor(input.nowMs, input.epochSeconds);
  const salt = bytesToB64Url(randomBytes(16));
  const exp = Math.floor(input.nowMs / 1000) + (input.ttlSeconds ?? 120);

  const claims: ChallengeClaims = {
    v: 1,
    ep: epoch,
    exp,
    d: input.difficulty,
    s: salt,
    bind: await computeBinding(input.binding, secret),
  };

  const payload = encodeJson(claims);
  const signature = await sign(`${CHALLENGE_PREFIX}.${payload}`, secret, input.domain, epoch);

  return {
    cid: `${CHALLENGE_PREFIX}.${payload}.${signature}`,
    salt,
    difficulty: input.difficulty,
    expiresAt: exp,
  };
}

/** The exact bytes both sides hash. Keep in lockstep with the client script. */
export function powPreimage(salt: string, nonce: string): Uint8Array {
  return utf8(`${salt}.${nonce}`);
}

export async function isValidProofOfWork(salt: string, nonce: string, difficulty: number): Promise<boolean> {
  const digest = await sha256(powPreimage(salt, nonce));
  return leadingZeroBits(digest) >= difficulty;
}

export interface SolveChallengeInput {
  cid: string;
  nonce: string;
  tpmSecret: string;
  domain: string;
  nowMs: number;
  epochSeconds: number;
  binding: BindingInput;
}

export type SolveFailure = TokenFailure | 'bad_proof_of_work';

export async function verifyChallengeSolution(
  input: SolveChallengeInput,
): Promise<{ ok: true; claims: ChallengeClaims } | { ok: false; reason: SolveFailure }> {
  const verified = await verifyEnvelope<ChallengeClaims>(
    input.cid,
    CHALLENGE_PREFIX,
    input.tpmSecret,
    input.domain,
    input.nowMs,
    input.epochSeconds,
  );
  if (!verified.ok) return verified;

  const expectedBinding = await computeBinding(input.binding, secretBytes(input.tpmSecret));
  if (expectedBinding !== verified.claims.bind) {
    return { ok: false, reason: 'binding_mismatch' };
  }

  if (!(await isValidProofOfWork(verified.claims.s, input.nonce, verified.claims.d))) {
    return { ok: false, reason: 'bad_proof_of_work' };
  }

  return { ok: true, claims: verified.claims };
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

export interface IssueTokenInput {
  tpmSecret: string;
  domain: string;
  nowMs: number;
  epochSeconds: number;
  ttlSeconds: number;
  level: TokenLevel;
  binding: BindingInput;
  sessionId?: string;
  clickwrapVersion?: string;
}

export async function issueToken(input: IssueTokenInput): Promise<{ token: string; claims: TokenClaims }> {
  const secret = secretBytes(input.tpmSecret);
  const epoch = epochFor(input.nowMs, input.epochSeconds);
  const iat = Math.floor(input.nowMs / 1000);

  const claims: TokenClaims = {
    v: 1,
    ep: epoch,
    sid: input.sessionId ?? bytesToB64Url(randomBytes(12)),
    iat,
    exp: iat + input.ttlSeconds,
    lvl: input.level,
    bind: await computeBinding(input.binding, secret),
    ...(input.clickwrapVersion ? { cw: input.clickwrapVersion } : {}),
  };

  const payload = encodeJson(claims);
  const signature = await sign(`${TOKEN_PREFIX}.${payload}`, secret, input.domain, epoch);
  return { token: `${TOKEN_PREFIX}.${payload}.${signature}`, claims };
}

export interface VerifyTokenInput {
  token: string | null | undefined;
  tpmSecret: string;
  domain: string;
  nowMs: number;
  epochSeconds: number;
  binding: BindingInput;
}

export async function verifyToken(input: VerifyTokenInput): Promise<VerifyResult<TokenClaims>> {
  if (!input.token) return { ok: false, reason: 'missing' };

  const verified = await verifyEnvelope<TokenClaims>(
    input.token,
    TOKEN_PREFIX,
    input.tpmSecret,
    input.domain,
    input.nowMs,
    input.epochSeconds,
  );
  if (!verified.ok) return verified;

  const expectedBinding = await computeBinding(input.binding, secretBytes(input.tpmSecret));
  if (expectedBinding !== verified.claims.bind) {
    return { ok: false, reason: 'binding_mismatch' };
  }

  return { ok: true, claims: verified.claims };
}

// ---------------------------------------------------------------------------
// Clickwrap acceptance
// ---------------------------------------------------------------------------

export interface ClickwrapClaims {
  v: 1;
  ep: number;
  exp: number;
  /** Accepted ToS version. */
  ver: string;
  /** Unix seconds the visitor clicked. */
  at: number;
  bind: string;
}

/**
 * Clickwrap acceptance has to survive far longer than a TPM token — a visitor
 * should not re-accept the terms every 15 minutes — so it rides its own slow
 * rolling window (30 days, giving 30-60 days of validity).
 */
export const CLICKWRAP_EPOCH_SECONDS = 2_592_000;

export async function issueClickwrap(input: {
  tpmSecret: string;
  domain: string;
  nowMs: number;
  ttlSeconds: number;
  version: string;
  binding: BindingInput;
}): Promise<string> {
  const secret = secretBytes(input.tpmSecret);
  const epoch = epochFor(input.nowMs, CLICKWRAP_EPOCH_SECONDS);
  const at = Math.floor(input.nowMs / 1000);

  const claims: ClickwrapClaims = {
    v: 1,
    ep: epoch,
    exp: at + input.ttlSeconds,
    ver: input.version,
    at,
    bind: await computeBinding(input.binding, secret),
  };

  const payload = encodeJson(claims);
  const signature = await sign(`cw1.${payload}`, secret, input.domain, epoch);
  return `cw1.${payload}.${signature}`;
}

export async function verifyClickwrap(input: {
  value: string | null | undefined;
  tpmSecret: string;
  domain: string;
  nowMs: number;
  requiredVersion: string;
}): Promise<VerifyResult<ClickwrapClaims>> {
  if (!input.value) return { ok: false, reason: 'missing' };

  const verified = await verifyEnvelope<ClickwrapClaims>(
    input.value,
    'cw1',
    input.tpmSecret,
    input.domain,
    input.nowMs,
    CLICKWRAP_EPOCH_SECONDS,
  );
  if (!verified.ok) return verified;

  if (verified.claims.ver !== input.requiredVersion) {
    return { ok: false, reason: 'binding_mismatch' };
  }
  return verified;
}
