import { normaliseConfig, type EdgeProjectConfig } from '@foundershield/shared';
import { configTtlSeconds, type Env } from './env.js';

/**
 * Resolves the protection policy for a hostname.
 *
 * Three tiers, fastest first:
 *   1. per-isolate memory  — nanoseconds, bounded by `MEMORY_TTL_MS`
 *   2. Workers KV          — a few ms, bounded by `FS_CONFIG_TTL_SECONDS`
 *   3. Supabase RPC        — the source of truth
 *
 * A negative result is cached too, so a flood of requests for a hostname that
 * is not ours cannot turn into a flood of database calls.
 */

const MEMORY_TTL_MS = 10_000;
const NEGATIVE_TTL_SECONDS = 30;

interface MemoryEntry {
  value: EdgeProjectConfig | null;
  expiresAt: number;
}

const memory = new Map<string, MemoryEntry>();

function kvKey(host: string): string {
  return `cfg:${host}`;
}

export function invalidateMemoryCache(host?: string): void {
  if (host) memory.delete(host);
  else memory.clear();
}

export async function purgeConfig(env: Env, host: string): Promise<void> {
  memory.delete(host);
  await env.FS_CONFIG.delete(kvKey(host));
}

function fromFallback(env: Env, host: string): EdgeProjectConfig | null {
  if (!env.FS_CONFIG_FALLBACK) return null;
  try {
    const parsed = JSON.parse(env.FS_CONFIG_FALLBACK) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const raw of list) {
      const config = normaliseConfig(raw);
      if (config && config.domain === host) return config;
    }
  } catch {
    // A malformed fallback must never take the proxy down.
  }
  return null;
}

async function fromSupabase(env: Env, host: string): Promise<EdgeProjectConfig | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/edge_config`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ p_domain: host }),
  });

  if (!response.ok) {
    console.error('edge_config lookup failed', response.status, await response.text().catch(() => ''));
    return null;
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  return normaliseConfig(payload);
}

export async function loadConfig(
  env: Env,
  host: string,
  ctx: ExecutionContext,
  nowMs: number,
): Promise<EdgeProjectConfig | null> {
  const cached = memory.get(host);
  if (cached && cached.expiresAt > nowMs) return cached.value;

  const remember = (value: EdgeProjectConfig | null): EdgeProjectConfig | null => {
    memory.set(host, { value, expiresAt: nowMs + MEMORY_TTL_MS });
    // Keep the isolate-local map from growing without bound on a busy colo.
    if (memory.size > 512) {
      for (const key of memory.keys()) {
        if (memory.size <= 256) break;
        memory.delete(key);
      }
    }
    return value;
  };

  const fallback = fromFallback(env, host);
  if (fallback) return remember(fallback);

  const kvHit = await env.FS_CONFIG.get(kvKey(host), 'json').catch(() => null);
  if (kvHit !== null) {
    // `false` is how a cached miss is stored, to distinguish it from "no entry".
    if (kvHit === false) return remember(null);
    const config = normaliseConfig(kvHit);
    if (config) return remember(config);
  }

  const fresh = await fromSupabase(env, host).catch((error) => {
    console.error('edge_config error', error);
    return null;
  });

  const ttl = configTtlSeconds(env);
  ctx.waitUntil(
    env.FS_CONFIG.put(kvKey(host), JSON.stringify(fresh ?? false), {
      expirationTtl: fresh ? ttl : NEGATIVE_TTL_SECONDS,
    }).catch(() => undefined),
  );

  return remember(fresh);
}
