import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
// Explicit extension: Vite's native config loader requires it, and warns
// without one.
import { ORIGIN_HTML, PROJECTS } from './test/fixtures.ts';

/**
 * Tests run inside workerd, not Node, so `HTMLRewriter`, Durable Objects and KV
 * behave exactly as they will in production. Outbound fetches are intercepted
 * and answered by a stub origin.
 *
 * vitest-pool-workers 0.20 (for Vitest 4) replaced `defineWorkersConfig` with a
 * Vite plugin: the same options, registered as a plugin rather than nested
 * under `test.poolOptions.workers`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      singleWorker: true,
      isolatedStorage: true,
      miniflare: {
        compatibilityDate: '2024-12-30',
        // Required by the pool itself, not by the worker under test.
        compatibilityFlags: ['nodejs_compat'],
        kvNamespaces: ['FS_CONFIG'],
        durableObjects: {
          RATE_LIMITER: { className: 'RateLimiterDurableObject', useSQLite: true },
        },
        bindings: {
          FS_ADMIN_KEY: 'test-admin-key',
          FS_CONFIG_TTL_SECONDS: '60',
          FS_CONFIG_FALLBACK: JSON.stringify(PROJECTS),
        },
        outboundService(request: Request) {
          const url = new URL(request.url);

          if (url.pathname === '/json') {
            return new Response(JSON.stringify({ data: 'protected' }), {
              headers: { 'content-type': 'application/json' },
            });
          }
          if (url.pathname === '/echo-headers') {
            return new Response(JSON.stringify(Object.fromEntries(request.headers)), {
              headers: { 'content-type': 'application/json' },
            });
          }
          if (url.pathname === '/strict-csp') {
            return new Response(ORIGIN_HTML, {
              headers: {
                'content-type': 'text/html',
                'content-security-policy': "default-src 'none'; script-src https://cdn.example.com",
              },
            });
          }

          return new Response(ORIGIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        },
      },
    }),
  ],
});
