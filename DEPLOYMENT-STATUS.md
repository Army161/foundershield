# FounderShield — Deployment Status

Live record of the beta deployment. Updated as work proceeds.

---

## Baseline (Rule Zero)

| | |
|---|---|
| Initial commit | `690a8cfa5dbb0311075f8d281112f3726071a49e` |
| Branch | `main` |
| Remote | `origin/main` — in sync (0 ahead, 0 behind) |
| Working tree | clean (only untracked `.claude/`) |
| Restore tag | `pre-deploy-baseline` |
| Restore branch | `restore/pre-deploy-baseline` |
| Node | v24.11.1 |
| npm | 11.6.2 |

No uncommitted work existed at baseline, so nothing was at risk. To roll back:
`git reset --hard pre-deploy-baseline`

### Toolchain note

`package.json` requires Node `>=22.12.0` and the CI workflow pins **Node 22**.
The local machine runs **Node 24.11.1**. This satisfies the engine constraint but
is *not* the version CI validates against. Local test results should be read with
that in mind; a green local run is not proof of a green CI run.

---

## Environment blocker (pre-existing, affects deployment)

The host machine ran out of disk during this session, which is what first
surfaced as an `ENOSPC` test failure.

| Consumer | Size |
|---|---|
| `docker_data.vhdx` | 128.8 GB (only ~35 GB in use; ~92 GB is unreclaimed slack) |
| `pagefile.sys` | 81.4 GB |
| `AppData\Roaming` | 51.0 GB (20.4 GB is `open-generative-ai`, untouched since 7/27) |
| **Free** | **~11 GB** |

**Root cause identified:** the Docker MCP Toolkit gateway leaks three containers
per reconnect (`mcp/node-code-sandbox`, `mcp/jetbrains`, `mcp/sqlite`), labelled
`docker-mcp=true`. 94 had accumulated, oldest 3 days. The resulting memory
pressure is what inflated the pagefile to 81 GB.

The Docker daemon subsequently stopped under the pressure, taking the local
Supabase stack with it.

**Outstanding, requires elevation this session does not have:**
- Compacting `docker_data.vhdx` (`diskpart compact vdisk`, or Docker Desktop →
  Settings → Resources → Disk usage → Reclaim space) — recovers ~92 GB
- Capping the pagefile is a system setting and is the operator's call

This does not block the deployment design, but it does constrain running the
full local verification suite.

---

## Deployment targets

| Target | Purpose | Status |
|---|---|---|
| Supabase (hosted) | Postgres, Auth, RLS, evidence storage | NOT STARTED |
| Cloudflare Workers | Edge proxy, KV, Durable Objects | NOT STARTED |
| Vercel | Next.js dashboard | NOT STARTED |
| DNS / registrar | Domain verification + traffic routing | NOT STARTED |

A pre-existing hosted Supabase project is referenced in the gitignored
`packages/dashboard/.env.local` (project ref redacted here; see that file).
Its service-role key is deliberately blank, with an in-file note that it must be
supplied by the operator. Whether that project is the intended production target
is unconfirmed.

---

## Verification results

Run at baseline commit `690a8cf` on Node 24.11.1. **All green.**

| Suite | Result | Detail |
|---|---|---|
| `npm test` — shared | PASS | 8 files, 162 tests |
| `npm test` — edge | PASS | 2 files, 48 tests (real workerd) |
| `npm run typecheck` | PASS | exit 0, all three packages |
| `npm run test:schema` | PASS | after `supabase db reset` — migrations verified from scratch |
| `npm run test:burden` | PASS | |
| `npm run test:agreements` | PASS | |
| `npm run test:billing` | PASS | |
| `npm run test:contract` | PASS | 22 checks against real PostgREST |
| dashboard production build | PASS | exit 0; 15 routes; middleware 92.5 kB |
| worker dry-run | PASS | exit 0; 96.99 KiB / 27.89 KiB gzip |
| `npm audit --omit=dev` | PASS | **0 vulnerabilities on the production path** |

Total: **376 checks across 7 suites**, plus a clean production build and worker
bundle. The schema suite runs after a full `db reset`, so the migrations
themselves are verified end to end rather than an accumulated local state.

### Step 2 — secret scan: PASS

- Only `.env.example` and `packages/edge/.dev.vars.example` are tracked; no real
  `.env` file has ever been committed (checked across all history with
  `--diff-filter=A`).
- `.gitignore` covers `.env`, `.env.local`, `.env*.local`, `.dev.vars`;
  `git check-ignore` confirms both live env files are ignored.
- No `sk_live_`/`sk_test_`/`whsec_`, private-key blocks, or Cloudflare/Vercel
  tokens in tracked content.
- The only JWT-shaped strings are in `scripts/verify-supabase-contract.ts`, and
  they are `??` fallbacks to Supabase's **public local-demo keys**
  (issuer `supabase-demo`), overridable by env var. Not a leak.

CI (`.github/workflows/ci.yml`) expects two repository secrets:
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

---

## Blockers

| # | Blocker | Type | Owner |
|---|---|---|---|
| 1 | Cloudflare account authorization | external credential | operator |
| 2 | Supabase production project authorization | external credential | operator |
| 3 | Vercel account authorization | external credential | operator |
| 4 | Real domain + registrar DNS access | external credential | operator |
| 5 | Host disk exhaustion / VHDX compaction | environment, needs admin | operator |

---

## Production URLs

| Component | URL |
|---|---|
| Dashboard | not deployed |
| Worker | not deployed |
| Supabase | not confirmed |

---

## Static security review (Steps 6, 9, 10, 11 — code-level portions)

Performed by reading the source. These are the parts of the production safety
review that do not require deployed infrastructure. Items needing live infra are
listed as BLOCKED in the verdict.

| Check | Result | Evidence |
|---|---|---|
| Token cookie flags | **PASS** | `endpoints.ts:81` — `Path=/; Max-Age=…; HttpOnly; Secure (when https); SameSite=Lax` |
| Admin endpoint auth | **PASS** | `endpoints.ts:128` — constant-time compare, and **fails closed when `FS_ADMIN_KEY` is unset** (`!expected \|\|`), so a missing secret cannot open the endpoint |
| Server secret exposure | **PASS** | No server secret carries a `NEXT_PUBLIC_` prefix. `SUPABASE_SERVICE_ROLE_KEY` is server-only |
| Service-role client isolation | **PASS** | `lib/supabase/server.ts` imports `next/headers` at module top level, so Next refuses to bundle it into a client component |
| Dashboard route protection | **PASS** | `middleware.ts` gates `/dashboard`; uses `getUser()` **not** `getSession()`, so a revoked session cannot linger behind a valid-looking cookie |
| Signing-link exemption | **PASS** | `/sign/*` deliberately bypasses the login redirect — the token is the only credential, and signers have no account |
| Fail-open behaviour | **PASS (static)** | `index.ts:224` — top-level catch falls through to a plain pass-through proxy tagged `x-foundershield: degraded`; 502 only when the origin itself is unreachable |
| Customer cannot self-verify a domain | **PASS** | `actions.ts:373` — `assertOwnership` first; the `status → active` flip is a **service-role** write gated on a real proxy fetch, and a domain reaching a *different* project's proxy is rejected |
| Legal overclaiming | **PASS** | Every match for prohibited phrasing is a disclaimer. `app/page.tsx:155` explicitly refuses the "federal crime" claim; NDA/terms generators label themselves templates, not legal advice |

### Hardening applied

`lib/supabase/server.ts` now opens with `import 'server-only'`, so importing it
from a Client Component is a hard build error rather than relying on the
`next/headers` import as an incidental guard. `server-only@0.0.1` was added to
the dashboard's dependencies.

### Advisory resolved: nanoid GHSA-2v37-7h3g-55p8 (high)

Surfaced mid-session — `nanoid@3.3.17` was already present at the baseline
commit unchanged, and the advisory was published between two audit runs, so it
was newly disclosed rather than newly introduced.

It arrives under `postcss`, which the repo already overrides, so it got the same
treatment: `"nanoid": "^3.3.18"` added to the root `overrides` block with a note
in the existing `//overrides` prose.

As the repo's own note warns, npm did not re-evaluate the override against the
existing tree — a `rm -rf node_modules package-lock.json` and clean reinstall was
required. That regenerated the lockfile, which is why its diff is large relative
to the change. Post-rebuild: `nanoid@3.3.18`, **`npm audit` reports 0
vulnerabilities on both the production path and the full tree**, and the entire
suite was re-run from scratch and passes.

---

## Credential blockers — action required

All three deployment CLIs are confirmed unauthenticated. Each needs an
interactive browser OAuth flow, which a non-interactive session cannot run.

| # | Service | Command to run | Why | What happens immediately after |
|---|---|---|---|---|
| 1 | Cloudflare | `npx wrangler login` (in `packages/edge`) | Create KV namespaces, Durable Object migration, set Worker secrets, deploy | Create `FS_CONFIG` + preview namespace, write real ids into `wrangler.toml`, generate `FS_ADMIN_KEY` with a CSPRNG, set the three Worker secrets, deploy, verify `/__fs/v1/health` |
| 2 | Supabase | `npx supabase login` | Link the production project and push `supabase/migrations` | `supabase link --project-ref <ref>`, `db push`, then re-run the schema/RLS verification against production read-only |
| 3 | Vercel | `npx vercel login` | Deploy the dashboard from the monorepo | Configure root dir `packages/dashboard`, set env vars server-side, preview deploy, verify auth + routes, then promote |

Two decisions I cannot make for you:

- **Which Supabase project is production.** `packages/dashboard/.env.local`
  references an existing project ref (redacted here) with a deliberately blank
  service-role key. Confirm whether that is the intended production target or
  whether a new project should be created.
- **Which real domain** to onboard as the first protected beta domain, and
  registrar/DNS access for it.

Nothing in Steps 3–12 can proceed until at least #1 and #2 are authorized.

---

## FOUNDERSHIELD DEPLOYMENT VERDICT

Repository commit: `690a8cfa5dbb0311075f8d281112f3726071a49e`
Branch: `main`

| Area | Status | Basis |
|---|---|---|
| Supabase | **BLOCKED** | not authenticated; local schema verified |
| Cloudflare Worker | **BLOCKED** | not authenticated; bundle dry-run passes |
| Dashboard | **BLOCKED** | production build passes; deploy not authorized |
| Authentication | **BLOCKED** | works against local Supabase; unverified in production |
| RLS | **PASS (local)** / BLOCKED (production) | 58 behaviour assertions after full reset |
| Domain verification | **BLOCKED** | requires deployed Worker + real domain |
| Traffic proxy | **BLOCKED** | requires deployed Worker |
| Monitor mode | **BLOCKED** | requires live traffic |
| Evidence capture | **PASS (local)** / BLOCKED (production) | contract suite drives real PostgREST writes |
| Evidence reporting | **BLOCKED** | requires real evidence |
| Fail-open behavior | **PASS (static)** / BLOCKED (live) | top-level catch verified by reading; not exercised against a real origin |
| Tests | **PASS** | 376 checks, 7 suites, plus build + bundle |
| Security review | **PASS (static)** / BLOCKED (live) | Step 2 secret scan plus 9 code-level checks pass; CORS/CSP-in-the-wild, TLS and live rate limiting need deployed infra |
| Legal claims (Step 11) | **PASS** | no prohibited claims; disclaimers present in copy and generators |
| Real-domain beta | **BLOCKED** | no domain connected |

### FINAL VERDICT: DEPLOYMENT BLOCKED

Blocked solely on external credentials, not on defects. The codebase itself is
in good shape: every suite passes, the production build and worker bundle are
clean, the production dependency path has zero advisories, and no secret is
exposed in the repository or its history.

This verdict says nothing about whether FounderShield works in production —
no component has been deployed, no real traffic has passed through it, and no
evidence has been captured outside a local test database. Per `docs/BETA.md`,
beta readiness additionally requires a week of monitor mode on a real domain
before enforcement is enabled at all.
