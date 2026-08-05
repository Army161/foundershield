export interface Env {
  /** Protection policy cache, keyed by hostname. */
  FS_CONFIG: KVNamespace;
  /** Optional — absence degrades rate limiting to per-isolate counting. */
  RATE_LIMITER?: DurableObjectNamespace;

  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Shared secret the dashboard uses to purge the policy cache. */
  FS_ADMIN_KEY?: string;
  /** How long a policy stays cached at the edge. */
  FS_CONFIG_TTL_SECONDS?: string;
  /**
   * JSON array of EdgeProjectConfig. Lets the whole proxy run with no Supabase
   * at all — used by `wrangler dev` and by the integration tests.
   */
  FS_CONFIG_FALLBACK?: string;
}

export function configTtlSeconds(env: Env): number {
  const parsed = Number(env.FS_CONFIG_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed >= 5 ? parsed : 60;
}
