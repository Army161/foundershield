# FounderShield

Anti-scraping protection and evidence capture for solo founders. A reverse proxy
at the edge that verifies browsers, enforces authorisation boundaries, and keeps
a tamper-evident record of what it stopped.

**All four phases complete and tested.** 376 checks pass across seven suites,
all three packages typecheck, the dashboard builds. Not yet deployed — see
[Deploying](#deploying) and [`docs/BETA.md`](docs/BETA.md).

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

Needs **Node 22.12 or newer** — wrangler 4 requires ≥22 and vite 8 requires
≥22.12, so the dev toolchain no longer runs on Node 20.

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
npm test        # 210 tests: 162 unit, 48 integration in real workerd (Vitest 4)
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

58 assertions covering RLS isolation, the column grants, tamper detection and
the cascade behaviour. Every check is a behaviour test — "can user B read user
A's evidence", not "did the DDL parse".

```bash
npm run test:burden
```

32 assertions on the Phase 2 aggregates: that burden totals are correct, that a
burst and a steady trickle are distinguishable, that the time window is
honoured, and that burden analysis respects RLS rather than bypassing it.

```bash
npm run test:agreements
```

31 assertions on signing and immutability: that a link signs exactly once, that
a completed signature cannot be reopened or rewritten, that a signed agreement
cannot be edited out from under its signature, and that signing tokens are not
readable by the dashboard client.

```bash
npm run test:billing
```

23 assertions on billing authority: that a customer cannot grant themselves a
plan or read Stripe identifiers, that a replayed webhook event is rejected, and
that usage is reported as an estimate whenever traffic was sampled.

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
| `GET /__fs/v1/terms` | Generated terms of use. `.txt` for plain text. |
| `POST /__fs/v1/admin/purge` | Drops a cached policy. Requires `X-FS-Admin-Key`. |

Two documents are served from the customer's own namespace, and only when
generated terms are configured:

| Path | Purpose |
|---|---|
| `/.well-known/ai-permissions.json` | Machine-readable AI/TDM policy. Always served — the terms assert it exists. |
| `/robots.txt` | Matching crawler policy. **Opt-in**, since that path usually already exists. |

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

## Phase 2

Two of the three planned Phase 2 items shipped in Phase 1 — the trespass
logging pipeline and clickwrap enforcement. Phase 2 filled the actual gaps:

**Generated terms of use.** Clauses describing the access controls this site
really enforces, served at `/__fs/v1/terms`. The version *is* a hash of the
rendered text, so editing any clause necessarily bumps the version and re-asks
everyone who accepted the old wording — you cannot quietly alter terms someone
already agreed to, which is the usual way clickwrap gets thrown out. The
matching machine-readable refusal is published alongside it, because the terms
say it exists.

It is a template and the UI says so plainly. Have a lawyer read it.

**Per-actor burden analysis.** Phase 1 recorded per-request cost but never
totalled it. `actor_burden()` aggregates requests, bytes, origin time consumed,
active span and peak per-minute rate per address. These are the only numbers
trespass to chattels can rest on — and if they turn out unremarkable, better to
know that before relying on the claim.

**Evidence report.** A presentable document rather than a CSV dump: how the
records were produced, a re-verification of every seal performed at render time
(printing the result even when a seal fails), per-actor load, which controls
each actor triggered, and an explicit limitations section. Print to PDF.

**Clickwrap presentation modes.** The interstitial withholds the page;
the new modal overlays it. The dashboard states the trade-off rather than
burying it: in modal mode the page has already been sent, so it supports
contract formation and nothing more. Modal mode is deliberately incapable of
relaxing a TPM or bot challenge — that combination still withholds the page.

## Phase 3

The EU AI Act beacon shipped in Phase 2, so Phase 3 covered the other two.

**NDA generation and signing.** Trade secret protection under 18 U.S.C. § 1836
is conditional on having taken reasonable measures to keep the information
secret; an NDA with everyone who sees it is the canonical one.

The detail worth having: § 1833(b)(3) requires these agreements to carry a
notice of whistleblower immunity, and omitting it forfeits exemplary damages
and attorney's fees against that person under § 1836(b)(3) — the two remedies
most worth having. Most templates omit it. This one includes it, defaults it on
for US governing law rather than expecting the founder to know to ask, and
`reviewNda()` flags it if it is turned off.

Signing records assent — who, when, from where, and a hash of the exact text —
in the same shape as the clickwrap record. A signed agreement is frozen at the
database level: editing it raises, because a signature against a document that
no longer exists is worse than no signature. It is not a qualified electronic
signature service and the UI does not claim otherwise.

**Notice drafting — split into the documents the facts actually support.** The
plan called for "DMCA notices from proxy logs", which conflates two unrelated
things. A § 512(c)(3)(A) takedown goes to a *host* about material republished on
their system; access logs are not evidence of that. So:

- **DMCA § 512 takedown** — built from the republication facts. `generateDmcaNotice`
  *refuses to draft* unless every statutory element is present, including the
  three statements the sender must make personally. Software cannot hold a
  good-faith belief, so software does not assert one — the checkboxes start
  unticked and there is no way to default them.
- **Circumvention / access demand** — built from the evidence log, because that
  is what the log evidences. Each draft reads its own evidence and says so when
  it is weak: no forged token means the circumvention letter tells you it is
  materially weaker than circumvention; no gated routes means the access letter
  cites *hiQ* at you and rests on your terms instead.

Nothing is ever sent. There is a "I sent this" button that records what the
operator did; there is no send button, and there will not be one.

## Phase 4

**Plan catalogue and Stripe billing.** Free / $20 / $50 / $150 / $300, with two
decisions worth knowing:

*Billing never gates traffic.* FounderShield sits in front of customers' users.
Enforcing a request quota would mean degrading their site to collect our
revenue — the same trade the proxy already refuses when it fails open. Domain
count and feature access are enforced in the dashboard, where refusing is safe.
Request volume is metered and reported, never enforced at the edge. Going over
produces a conversation, not a throttle.

*Nothing that keeps a live site standing up is behind a paywall.* Browser
verification, bot scoring and rate limiting are on every plan including free. A
free user being scraped is still protected. Paid plans add scale, retention and
the legal tooling. A test asserts this structurally, and that plans never lose a
feature as tiers ascend.

Stripe is entirely optional — with no keys, the dashboard runs on the free plan
and says so. The webhook verifies signatures against the raw body, records every
event id before acting so retries cannot double-apply, and maps an unrecognised
price to *free* rather than guessing upward. `past_due` keeps its plan: a failed
card should not silently strip a customer's protection settings.

**Landing page.** At `/`, statically rendered, with pricing generated from the
same catalogue the dashboard enforces — so they cannot drift.

The copy deliberately does **not** claim that bypassing FounderShield is a
federal offence, and there is a comment in the source explaining why to whoever
edits it next. The page has a section saying what the product will *not* tell
you. That is not modesty: "we produce the record you would otherwise not have"
is a claim that survives contact with a lawyer, and the alternative is a false
advertising exposure the customer would be relying on.

**Beta onboarding.** [`docs/BETA.md`](docs/BETA.md) — a runbook, since this part
is not code. Includes the pre-flight checklist, what to watch in priority order
(false positives first, by a distance), the known gaps to disclose up front, and
the exit criteria.

## Not yet built

- **Plan feature enforcement.** `planAllows()` and `lowestPlanWith()` in
  `packages/shared/src/plans.ts` are correct and unit-tested, but nothing in
  the dashboard calls them. The only plan limit actually enforced today is
  domain count (`canAddDomain`). Every paid-tier feature — strict mode,
  protected routes, generated terms, evidence seals, evidence reports,
  agreements, notices — is usable on the free plan. See
  [`DEPLOYMENT-STATUS.md`](DEPLOYMENT-STATUS.md) for how this was found.
- Independent reverse-DNS verification of search crawlers (currently trusts
  Cloudflare's `verifiedBotCategory`)
- External timestamping of evidence seals
- Automatic enforcement of evidence retention windows per plan
