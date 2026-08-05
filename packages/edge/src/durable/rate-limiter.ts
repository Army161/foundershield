/**
 * Sharded sliding-window rate limiter.
 *
 * One Durable Object instance owns 1/256th of a project's clients (sharded on
 * the IP hash), so counters are globally consistent without one object per
 * visitor. Counts live in memory — an eviction loses at most one window — but
 * *bans* are persisted, because forgetting a ban is the failure mode that
 * actually matters.
 */

export interface RateLimitQuery {
  key: string;
  /** Sustained allowance per window. */
  limit: number;
  windowMs: number;
  /** Extra requests tolerated above the sustained rate. */
  burst: number;
  banSeconds: number;
  now: number;
}

export interface RateLimitVerdict {
  limited: boolean;
  /** Estimated requests in the current sliding window, including this one. */
  observed: number;
  retryAfterSeconds: number;
}

interface Bucket {
  windowStart: number;
  count: number;
  previousCount: number;
  bannedUntil: number;
}

const BAN_KEY_PREFIX = 'ban:';

export class RateLimiterDurableObject {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly state: DurableObjectState,
    _env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    let query: RateLimitQuery;
    try {
      query = (await request.json()) as RateLimitQuery;
    } catch {
      return Response.json({ error: 'bad_request' }, { status: 400 });
    }

    const verdict = await this.check(query);
    return Response.json(verdict);
  }

  private async check(query: RateLimitQuery): Promise<RateLimitVerdict> {
    const { key, limit, windowMs, burst, banSeconds, now } = query;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Only a persisted ban can outlive an eviction; counts start fresh.
      const bannedUntil = (await this.state.storage.get<number>(`${BAN_KEY_PREFIX}${key}`)) ?? 0;
      bucket = { windowStart: now, count: 0, previousCount: 0, bannedUntil };
      this.buckets.set(key, bucket);
      if (this.buckets.size > 10_000) this.evictOldest(now, windowMs);
    }

    if (bucket.bannedUntil > now) {
      return {
        limited: true,
        observed: bucket.count,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.bannedUntil - now) / 1000)),
      };
    }

    if (bucket.bannedUntil !== 0) {
      // Ban served. Durable Object storage has no TTL, so expired bans are
      // cleared on the next touch rather than left to accumulate.
      bucket.bannedUntil = 0;
      await this.state.storage.delete(`${BAN_KEY_PREFIX}${key}`);
    }

    const elapsed = now - bucket.windowStart;
    if (elapsed >= windowMs) {
      // Carry the previous window forward only if it is still adjacent.
      bucket.previousCount = elapsed < windowMs * 2 ? bucket.count : 0;
      bucket.count = 0;
      bucket.windowStart += Math.floor(elapsed / windowMs) * windowMs;
    }

    const weight = 1 - (now - bucket.windowStart) / windowMs;
    const estimate = bucket.previousCount * Math.max(0, weight) + bucket.count + 1;

    if (estimate > limit + burst) {
      if (banSeconds > 0) {
        bucket.bannedUntil = now + banSeconds * 1000;
        await this.state.storage.put(`${BAN_KEY_PREFIX}${key}`, bucket.bannedUntil);
      }
      return {
        limited: true,
        observed: Math.round(estimate),
        retryAfterSeconds: Math.max(1, banSeconds || Math.ceil(windowMs / 1000)),
      };
    }

    bucket.count += 1;
    return { limited: false, observed: Math.round(estimate), retryAfterSeconds: 0 };
  }

  private evictOldest(now: number, windowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.bannedUntil > now) continue;
      if (now - bucket.windowStart > windowMs * 2) this.buckets.delete(key);
      if (this.buckets.size <= 5_000) break;
    }
  }
}

/**
 * Per-isolate fallback used when no Durable Object binding is configured (local
 * dev, tests, or a deliberately cheap deployment). Counts only what this
 * isolate sees, so the effective limit scales with the number of live isolates.
 */
const localBuckets = new Map<string, Bucket>();

export function checkRateLimitLocally(query: RateLimitQuery): RateLimitVerdict {
  const { key, limit, windowMs, burst, banSeconds, now } = query;
  let bucket = localBuckets.get(key);
  if (!bucket) {
    bucket = { windowStart: now, count: 0, previousCount: 0, bannedUntil: 0 };
    localBuckets.set(key, bucket);
    if (localBuckets.size > 20_000) localBuckets.clear();
  }

  if (bucket.bannedUntil > now) {
    return {
      limited: true,
      observed: bucket.count,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.bannedUntil - now) / 1000)),
    };
  }

  const elapsed = now - bucket.windowStart;
  if (elapsed >= windowMs) {
    bucket.previousCount = elapsed < windowMs * 2 ? bucket.count : 0;
    bucket.count = 0;
    bucket.windowStart += Math.floor(elapsed / windowMs) * windowMs;
  }

  const weight = 1 - (now - bucket.windowStart) / windowMs;
  const estimate = bucket.previousCount * Math.max(0, weight) + bucket.count + 1;

  if (estimate > limit + burst) {
    if (banSeconds > 0) bucket.bannedUntil = now + banSeconds * 1000;
    return {
      limited: true,
      observed: Math.round(estimate),
      retryAfterSeconds: Math.max(1, banSeconds || Math.ceil(windowMs / 1000)),
    };
  }

  bucket.count += 1;
  return { limited: false, observed: Math.round(estimate), retryAfterSeconds: 0 };
}

/** Test seam. */
export function resetLocalRateLimiter(): void {
  localBuckets.clear();
}
