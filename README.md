# FounderShield

Anti-scraping protection and evidence capture for solo founders. A reverse proxy
at the edge that verifies browsers, enforces authorisation boundaries, and keeps
a tamper-evident record of what it stopped.

**Phase 1 status: complete and tested.** 114 tests pass, all three packages
typecheck, the dashboard builds. Not yet deployed — see [Deploying](#deploying).

```
packages/shared      zero-dependency core: rolling-key tokens, policy, detection
packages/edge        Cloudflare Worker reverse proxy
packages/dashboard   Next.js 15 dashboard on Supabase
supabase/migrations  schema, RLS, evidence sealing
docs/LEGAL-MAPPING   what each layer does legally, and how strong it actually is
```

Read [`docs/LEGAL-MAPPING.md`](docs/LEGAL-MAPPING.md) before writing any
marketing copy for this product.

---

## How it works

```
visitor ──▶ Cloudflare Worker ──▶ your origin
               │
               ├─ access lists      IP / user-agent allow and block
               ├─ automation score  header analysis, no JS required
               ├─ rate limit        sharded Durable Object counters
               ├─ auth gate         protected routes (the CFAA layer)
               ├─ terms acceptance  clickwrap, versioned and signed
               └─ browser check     proof-of-work + rolling-key token (the §1201 layer)
                        │
                        └─▶ evidence log ──▶ Supabase (append-only)
```

Three enforcement modes:

| Mode | First page load | API / assets | Use when |
|---|---|---|---|
| `monitor` | served | served | First 24–48h on a live domain. Records what *would* happen. |
| `standard` | served, carries the challenge | requires a verified browser | Default. Right for most sites. |
| `strict` | interstitial until verified | requires a verified browser | Highest value content. Visitors see a brief check. |

### The browser check

1. The proxy injects `<script src="/__fs/v1/c.js">` into your HTML (same-origin,
   so it survives `script-src 'self'` without a nonce).
2. The script fetches a signed challenge and solves a SHA-256 proof-of-work —
   about 50 ms at the default difficulty, chunked so it never blocks paint.
3. On success the edge sets a short-lived `HttpOnly` token cookie.
4. Every later request is verified at the edge with no origin round-trip.

Signing keys are re-derived from the project secret on a fixed interval, so a
captured token stops working after two rotations without either side storing
session state. A token that merely expired is re-challenged; a token whose
signature does not verify is **blocked and recorded separately**, because those
are materially different facts.

---

## Running locally

```bash
npm install
```

The proxy runs with no Supabase at all — set `FS_CONFIG_FALLBACK` to a JSON
array of project configs in `packages/edge/.dev.vars`:

```bash
cp packages/edge/.dev.vars.example packages/edge/.dev.vars
npm run dev:edge
```

```bash
npm test        # 114 tests: 80 unit, 34 integration in real workerd
npm run typecheck
```

Edge tests run inside workerd via `@cloudflare/vitest-pool-workers`, so
`HTMLRewriter`, Durable Objects and KV behave exactly as in production.

---

## Validating the schema

The database has its own two suites, run against a real local Supabase (same
Postgres 17, same `auth` schema, same `anon` / `authenticated` / `service_role`
roles). Requires Docker.

```bash
npm run db:start
```

```bash
npm run test:schema
```

59 assertions covering RLS isolation, the column grants, tamper detection and
the cascade behaviour. Every check is a behaviour test — "can user B read user
A's evidence", not "did the DDL parse".

```bash
npm run test:contract
```

22 checks driving the exact two PostgREST calls the worker makes: the
`edge_config` policy lookup (fed through the real `normaliseConfig`) and the
evidence write. This seam is worth testing on its own because both of its
failure modes are **silent** — a rejected policy lookup leaves a domain
unprotected, and a rejected evidence write is logged and discarded.

```bash
npm run db:stop
```

Three real defects were found and fixed this way, all of which would have
shipped:

1. **Seals did not detect edits.** `row_hash` was computed only on INSERT and
   verification re-hashed those stored values, so an UPDATE to any observation
   column left every digest matching. Verification now recomputes each row's
   hash from its current contents, and reports `alteredRows` to localise the
   change. An attacker who edits a row *and* recomputes its stored hash still
   breaks the chained digest.
2. **`authenticated` could not read its own evidence.** The schema was relying
   on Supabase's ambient default privileges. Every grant is now explicit.
3. **`service_role` could not write evidence at all.** Same root cause, but this
   one fails silently in production: the proxy would have recorded nothing while
   appearing healthy.

---

## Deploying

### 1. Database

Apply [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) to
a Supabase project:

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
```

```bash
npx supabase db push
```

The migration is validated against real Supabase Postgres 17 — see
[Validating the schema](#validating-the-schema).

### 2. Edge worker

```bash
cd packages/edge
npx wrangler kv namespace create FS_CONFIG
npx wrangler kv namespace create FS_CONFIG --preview
# put both ids into wrangler.toml

npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put FS_ADMIN_KEY        # openssl rand -hex 32

npx wrangler deploy
```

Customer domains attach either as routes in `wrangler.toml` or — the scalable
option — via [Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/)
custom hostnames.

### 3. Dashboard

```bash
cp .env.example packages/dashboard/.env.local   # fill in
npm run dev:dashboard
```

Deploys to Vercel unmodified. `FS_ADMIN_KEY` must match the worker's.

### 4. Customer onboarding

The dashboard shows both records:

| Type | Name | Value |
|---|---|---|
| TXT | `_foundershield.example.com` | `fs-verify=<token>` |
| CNAME | `example.com` | your edge hostname |

**Verify** checks the TXT record over DNS-over-HTTPS *and* fetches
`https://<domain>/__fs/v1/health` to confirm the traffic actually reaches the
proxy and is serving the right project. A domain only goes `active` when both
pass — a customer cannot mark their own domain verified.

---

## Reserved paths

Everything under `/__fs/v1/` is handled by the proxy and never forwarded, so it
cannot be shadowed or impersonated by an origin app.

| Path | Purpose |
|---|---|
| `GET /__fs/v1/health` | Status. Used by DNS verification. |
| `GET /__fs/v1/c.js` | Challenge client. |
| `GET /__fs/v1/challenge` | Issues a signed challenge. |
| `POST /__fs/v1/verify` | Accepts a solution, sets the token cookie. |
| `POST /__fs/v1/clickwrap` | Records terms acceptance. |
| `POST /__fs/v1/admin/purge` | Drops a cached policy. Requires `X-FS-Admin-Key`. |

Your origin receives `X-Foundershield-Verified: 0|1`, `X-Foundershield-Project`,
`X-Forwarded-For` and `X-Forwarded-Host`. Proxy cookies (`__fs_*`) are stripped
before forwarding.

---

## Design decisions worth knowing

**It fails open.** An unhandled error in the protection layer falls through to a
plain pass-through proxy rather than returning an error. A bug in our code must
not become an outage for the customer's users — that trades their availability
for our correctness, which is not our trade to make.

**Rate limiting degrades rather than fails.** If the Durable Object is
unreachable, counting falls back to per-isolate approximation instead of
blocking or erroring.

**The customer never asserts their own facts.** Domain verification, project
status and the project secret are all service-role writes. The secret has no
column grant for `authenticated` at all, so a query that selected it would fail
rather than leak it.

**Monitor mode records the decision *and* whether it was enforced.** The
`enforced` column is what makes a dry run readable before switching on.

---

## Not in Phase 1

Deliberately out of scope, in rough priority order:

- Automated DMCA notice generation — see rule 2 in the legal mapping. Evidence
  export is the product; sending a threat is a lawyer's call.
- NDA generation and e-sign (DTSA layer)
- `robots.txt` / `ai-permissions.json` hosting (EU AI Act layer)
- Stripe billing and tiers
- Reverse-DNS verification of search crawlers (currently trusts Cloudflare's
  `verifiedBotCategory`)
- External timestamping of evidence seals
