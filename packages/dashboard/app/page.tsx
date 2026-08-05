import Link from 'next/link';
import {
  FEATURE_LABELS,
  PLANS,
  PLAN_ORDER,
  UNIVERSAL_CAPABILITIES,
  formatPrice,
  formatRequests,
  formatRetention,
} from '@foundershield/shared';

export const metadata = {
  title: 'FounderShield — anti-scraping and evidence capture for solo founders',
  description:
    'A reverse proxy that verifies browsers, enforces authorisation boundaries, and keeps a tamper-evident record of what it stopped.',
};

/**
 * Landing page.
 *
 * A note for whoever edits this next. The source material for this product
 * describes bypassing it as "a federal offense". That claim is not made here
 * and should not be added, for a reason that protects the business rather than
 * hobbling it: DMCA § 1201 as applied to bot mitigation is contested, it needs
 * a nexus to a copyrighted work, and stating it as settled is a false
 * advertising exposure — one the customer would be relying on when they act.
 *
 * The honest version is stronger anyway. "We produce the record you would
 * otherwise not have" is a claim that survives contact with a lawyer.
 * See docs/LEGAL-MAPPING.md.
 */

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="mt-1 shrink-0">
      <path d="M3 8.5l3.5 3.5L13 5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="text-sm font-semibold tracking-tight">FounderShield</span>
          <nav className="flex items-center gap-5 text-sm">
            <a href="#how" className="text-ink-soft hover:text-ink">
              How it works
            </a>
            <a href="#pricing" className="text-ink-soft hover:text-ink">
              Pricing
            </a>
            <Link href="/login" className="font-medium">
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-3xl px-6 pb-16 pt-20 text-center">
          <h1 className="text-4xl font-semibold leading-[1.1] tracking-[-0.02em] sm:text-5xl">
            Stop the scraping.
            <br />
            Keep the receipts.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg text-ink-soft">
            A reverse proxy that verifies real browsers before serving your content, closes the routes that should be
            closed, and keeps a tamper-evident record of everything it refused.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/login" className="btn px-5 py-2.5">
              Protect a domain
            </Link>
            <a href="#how" className="btn-secondary px-5 py-2.5">
              See how it works
            </a>
          </div>
          <p className="mt-4 text-sm text-ink-faint">Free plan, one domain, no card.</p>
        </section>

        <section className="border-y border-line bg-white">
          <div className="mx-auto grid max-w-5xl gap-8 px-6 py-14 sm:grid-cols-3">
            <div>
              <h2 className="text-base font-semibold">Two DNS records</h2>
              <p className="mt-1.5 text-sm text-ink-soft">
                A TXT record to prove the domain is yours, a CNAME to route traffic through us. No SDK, no code change,
                nothing to install in your app.
              </p>
            </div>
            <div>
              <h2 className="text-base font-semibold">It fails open</h2>
              <p className="mt-1.5 text-sm text-ink-soft">
                If our protection layer breaks, your site still serves. We will not trade your users&rsquo;
                availability for our correctness — and we will never throttle your traffic over a billing question.
              </p>
            </div>
            <div>
              <h2 className="text-base font-semibold">Start in monitor mode</h2>
              <p className="mt-1.5 text-sm text-ink-soft">
                Run for a day and see exactly what enforcement <em>would</em> have done, before anything is blocked for
                real.
              </p>
            </div>
          </div>
        </section>

        <section id="how" className="mx-auto max-w-3xl px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">What it actually does</h2>

          <div className="mt-8 space-y-8">
            <div>
              <h3 className="font-semibold">Verifies the browser before serving content</h3>
              <p className="mt-1.5 text-sm text-ink-soft">
                Every visitor&rsquo;s browser completes a short cryptographic challenge — invisibly, in about the time
                it takes a page to paint — and is issued a short-lived signed token. Signing keys rotate continuously,
                so a captured token stops working. A scraper pays that cost on every single request; a person pays it
                once.
              </p>
            </div>

            <div>
              <h3 className="font-semibold">Closes the routes that should be closed</h3>
              <p className="mt-1.5 text-sm text-ink-soft">
                Name the paths that require a signed-in session, an issued key, or a specific network, and they stop
                being publicly served. This is the part that matters most if you ever have to act on an incident: the
                law treats gated content very differently from content you simply published.
              </p>
            </div>

            <div>
              <h3 className="font-semibold">Writes down what happened</h3>
              <p className="mt-1.5 text-sm text-ink-soft">
                Every refusal is recorded as it happens — the address, the time, what was asked for, and which control
                stopped it, in plain English. Records are append-only, hashed on write, and can be sealed so a later
                edit is detectable. Your own account has no permission to change them, which is exactly what makes them
                worth having.
              </p>
            </div>

            <div>
              <h3 className="font-semibold">Generates the paperwork, and stops there</h3>
              <p className="mt-1.5 text-sm text-ink-soft">
                Terms of use that describe the controls you actually run. NDAs that include the statutory notice most
                templates leave out. Draft demand letters built from your own logs. FounderShield drafts — it never
                sends, and it will never tick a sworn statement on your behalf.
              </p>
            </div>
          </div>

          <div className="mt-10 rounded-xl border border-line bg-white p-6">
            <h3 className="font-semibold">What we will not tell you</h3>
            <p className="mt-2 text-sm text-ink-soft">
              Plenty of tools in this category will tell you that bypassing them is a federal crime. We do not, because
              it depends — on your content, your jurisdiction, and facts a proxy cannot see. Anti-circumvention law as
              applied to bot mitigation is genuinely contested, and scraping a page you published openly is usually not
              unauthorised access at all.
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              What we will tell you is this: the hard part of acting on a scraping incident is proving what happened,
              and that is a problem you can only solve <em>before</em> it happens. That is what this is for. Take the
              export to a lawyer — don&rsquo;t take a dashboard for one.
            </p>
          </div>
        </section>

        <section id="pricing" className="border-t border-line bg-white">
          <div className="mx-auto max-w-5xl px-6 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">Pricing</h2>
            <p className="mt-2 max-w-2xl text-sm text-ink-soft">
              Nothing that keeps a live site standing up is behind a paywall. Verification, bot scoring and rate
              limiting are on every plan, free included. Paid plans add scale, retention, and the legal tooling.
            </p>

            <ul className="mt-6 grid gap-1.5 text-sm text-ink-soft sm:grid-cols-2">
              {UNIVERSAL_CAPABILITIES.map((capability) => (
                <li key={capability} className="flex gap-2">
                  <Check />
                  {capability}
                </li>
              ))}
            </ul>

            <div className="mt-10 grid gap-4 lg:grid-cols-3">
              {PLAN_ORDER.map((id) => {
                const plan = PLANS[id];
                return (
                  <div key={id} className="flex flex-col rounded-xl border border-line bg-surface p-6">
                    <div className="flex items-baseline justify-between">
                      <h3 className="font-semibold">{plan.name}</h3>
                      <span className="text-lg font-semibold tabular-nums">{formatPrice(plan)}</span>
                    </div>
                    <p className="mt-1 text-sm text-ink-faint">{plan.tagline}</p>

                    <ul className="mt-4 flex-1 space-y-1.5 text-sm text-ink-soft">
                      <li className="flex gap-2">
                        <Check />
                        {plan.domains} domain{plan.domains === 1 ? '' : 's'}
                      </li>
                      <li className="flex gap-2">
                        <Check />
                        {formatRequests(plan.includedRequests)} requests/month
                      </li>
                      <li className="flex gap-2">
                        <Check />
                        {formatRetention(plan.retentionDays)} evidence retention
                      </li>
                      {plan.features.map((feature) => (
                        <li key={feature} className="flex gap-2">
                          <Check />
                          {FEATURE_LABELS[feature]}
                        </li>
                      ))}
                    </ul>

                    <Link href="/login" className={`mt-6 ${id === 'free' ? 'btn-secondary' : 'btn'} w-full`}>
                      {id === 'free' ? 'Start free' : `Choose ${plan.name}`}
                    </Link>
                  </div>
                );
              })}
            </div>

            <p className="mt-6 text-sm text-ink-faint">
              Request allowances are guidance, not a cut-off. Go over and we will talk to you about it — we will not
              throttle your site or degrade its protection to collect a bill.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-sm text-ink-faint">
          <span>FounderShield</span>
          <span>
            Not a law firm, and nothing here is legal advice. It is a technical control and a record of what it did.
          </span>
        </div>
      </footer>
    </div>
  );
}
