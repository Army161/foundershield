import { describe, expect, it } from 'vitest';
import {
  generateSecret,
  isValidProofOfWork,
  issueChallenge,
  issueToken,
  verifyChallengeSolution,
  verifyToken,
  issueClickwrap,
  verifyClickwrap,
  powPreimage,
} from './token';
import { sha256 } from './crypto';
import { leadingZeroBits } from './encoding';

const DOMAIN = 'app.example.com';
const EPOCH = 900;
const NOW = 1_800_000_000_000;

const binding = { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 Chrome/131', bindIp: false, bindUserAgent: true };

/** Brute-force a nonce the way the browser challenge does. */
async function solve(salt: string, difficulty: number): Promise<string> {
  for (let i = 0; i < 5_000_000; i++) {
    const nonce = String(i);
    const digest = await sha256(powPreimage(salt, nonce));
    if (leadingZeroBits(digest) >= difficulty) return nonce;
  }
  throw new Error('no solution found');
}

describe('access tokens', () => {
  it('round-trips a freshly issued token', async () => {
    const tpmSecret = generateSecret();
    const { token } = await issueToken({
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      ttlSeconds: 3600,
      level: 'pow',
      binding,
    });

    const result = await verifyToken({ token, tpmSecret, domain: DOMAIN, nowMs: NOW, epochSeconds: EPOCH, binding });
    expect(result.ok).toBe(true);
  });

  it('rejects a token signed with a different project secret', async () => {
    const { token } = await issueToken({
      tpmSecret: generateSecret(),
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      ttlSeconds: 3600,
      level: 'pow',
      binding,
    });

    const result = await verifyToken({
      token,
      tpmSecret: generateSecret(),
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      binding,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token replayed against a different domain', async () => {
    const tpmSecret = generateSecret();
    const { token } = await issueToken({
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      ttlSeconds: 3600,
      level: 'pow',
      binding,
    });

    const result = await verifyToken({
      token,
      tpmSecret,
      domain: 'other.example.com',
      nowMs: NOW,
      epochSeconds: EPOCH,
      binding,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('accepts a token from the immediately previous epoch but not older', async () => {
    const tpmSecret = generateSecret();
    const { token } = await issueToken({
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      ttlSeconds: 86_400,
      level: 'pow',
      binding,
    });

    const oneEpochLater = await verifyToken({
      token,
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW + EPOCH * 1000,
      epochSeconds: EPOCH,
      binding,
    });
    expect(oneEpochLater.ok).toBe(true);

    const threeEpochsLater = await verifyToken({
      token,
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW + EPOCH * 3000,
      epochSeconds: EPOCH,
      binding,
    });
    expect(threeEpochsLater).toEqual({ ok: false, reason: 'stale_epoch' });
  });

  it('rejects an expired token', async () => {
    const tpmSecret = generateSecret();
    const { token } = await issueToken({
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      ttlSeconds: 60,
      level: 'pow',
      binding,
    });

    const result = await verifyToken({
      token,
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW + 61_000,
      epochSeconds: EPOCH,
      binding,
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token lifted to another client when user-agent is pinned', async () => {
    const tpmSecret = generateSecret();
    const { token } = await issueToken({
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      ttlSeconds: 3600,
      level: 'pow',
      binding,
    });

    const result = await verifyToken({
      token,
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      binding: { ...binding, userAgent: 'python-requests/2.32' },
    });
    expect(result).toEqual({ ok: false, reason: 'binding_mismatch' });
  });

  it.each(['', 'garbage', 'fs1.only-two', 'xx1.a.b', 'fs1..'])('rejects malformed token %j', async (token) => {
    const result = await verifyToken({
      token,
      tpmSecret: generateSecret(),
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      binding,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a token whose payload was tampered with', async () => {
    const tpmSecret = generateSecret();
    const { token } = await issueToken({
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      ttlSeconds: 60,
      level: 'pow',
      binding,
    });

    const [prefix, payload, signature] = token.split('.') as [string, string, string];
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    claims.exp += 86_400; // try to extend our own token
    const forged = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const result = await verifyToken({
      token: `${prefix}.${forged}.${signature}`,
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      binding,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('challenges', () => {
  it('issues a challenge that a correct proof-of-work satisfies', async () => {
    const tpmSecret = generateSecret();
    const challenge = await issueChallenge({
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      difficulty: 10,
      binding,
    });

    const nonce = await solve(challenge.salt, challenge.difficulty);
    expect(await isValidProofOfWork(challenge.salt, nonce, challenge.difficulty)).toBe(true);

    const result = await verifyChallengeSolution({
      cid: challenge.cid,
      nonce,
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      binding,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong nonce', async () => {
    const tpmSecret = generateSecret();
    const challenge = await issueChallenge({
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      difficulty: 16,
      binding,
    });

    const result = await verifyChallengeSolution({
      cid: challenge.cid,
      nonce: 'definitely-not-the-answer',
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      binding,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_proof_of_work' });
  });

  it('rejects a challenge whose difficulty was lowered by the client', async () => {
    const tpmSecret = generateSecret();
    const challenge = await issueChallenge({
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      difficulty: 20,
      binding,
    });

    const [prefix, payload, signature] = challenge.cid.split('.') as [string, string, string];
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    claims.d = 1;
    const forged = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const result = await verifyChallengeSolution({
      cid: `${prefix}.${forged}.${signature}`,
      nonce: await solve(claims.s, 1),
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      binding,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an expired challenge', async () => {
    const tpmSecret = generateSecret();
    const challenge = await issueChallenge({
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      epochSeconds: EPOCH,
      difficulty: 8,
      ttlSeconds: 30,
      binding,
    });

    const result = await verifyChallengeSolution({
      cid: challenge.cid,
      nonce: await solve(challenge.salt, 8),
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW + 31_000,
      epochSeconds: EPOCH,
      binding,
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('clickwrap', () => {
  it('round-trips and survives well past a TPM epoch', async () => {
    const tpmSecret = generateSecret();
    const value = await issueClickwrap({
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      ttlSeconds: 60 * 60 * 24 * 30,
      version: '3',
      binding,
    });

    const result = await verifyClickwrap({
      value,
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW + 86_400_000,
      requiredVersion: '3',
    });
    expect(result.ok).toBe(true);
  });

  it('invalidates acceptance when the terms version is bumped', async () => {
    const tpmSecret = generateSecret();
    const value = await issueClickwrap({
      tpmSecret,
      domain: DOMAIN,
      nowMs: NOW,
      ttlSeconds: 3600,
      version: '3',
      binding,
    });

    const result = await verifyClickwrap({ value, tpmSecret, domain: DOMAIN, nowMs: NOW, requiredVersion: '4' });
    expect(result.ok).toBe(false);
  });
});
