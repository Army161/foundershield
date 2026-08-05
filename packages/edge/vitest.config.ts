import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { ORIGIN_HTML, PROJECTS } from './test/fixtures.js';

/**
 * Tests run inside workerd, not Node, so `HTMLRewriter`, Durable Objects and KV
 * behave exactly as they will in production. Outbound fetches are intercepted
 * and answered by a stub origin.
 */
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
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
      },
    },
  },
});
