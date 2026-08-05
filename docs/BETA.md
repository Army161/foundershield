# Beta onboarding

Phase 4 calls for onboarding 5–10 indie developers. That is not something the
codebase can do for you, so this is the runbook — what to do, in what order, and
what to watch for.

---

## Before anyone else touches it

Run FounderShield in front of one of your own domains for a week first. Not a
staging domain — a real one with real traffic. Every failure mode below was
found by reasoning about the design; running it yourself is how you find the
ones that weren't.

Specifically, confirm:

- [ ] Two DNS records added, `Verify` passes, project goes `active`.
- [ ] A week in `monitor` mode. Read the activity log daily. **If enforcement
      would have blocked anything you recognise as a real user, do not move on.**
- [ ] Switch to `standard`. Check your own site in a private window, on mobile
      data, and with an ad blocker on.
- [ ] Check your analytics for a drop in traffic or conversions. A silent 5%
      loss to false positives is the failure that will kill this product.
- [ ] Confirm Googlebot still reaches you (Search Console → URL inspection).
- [ ] Trip a rate limit on purpose and confirm you can get back in.

---

## Choosing the first cohort

Aim for five, not ten. You want people you can talk to properly.

Good first users have: a live site with real traffic, a reason to care about
scraping, and enough technical confidence to change DNS. Bad first users are
pre-launch — they have no traffic, so they cannot tell you anything, and they
will churn when they lose interest in the side project.

Deliberately recruit **one person with a heavily international audience** and
**one with a lot of mobile traffic**. Those are the two populations most likely
to expose false positives, and you want to find that out at five users rather
than five hundred.

---

## The onboarding conversation

Fifteen minutes, live, for each of the first five. Not a docs link.

1. **Set expectations honestly.** They are beta user number three. Tell them
   what has and has not been run in production. Tell them it fails open, and
   what that means: if we break, their site still serves.
2. **Get them into monitor mode and leave it there.** Do not let anyone enable
   enforcement on day one, however keen they are.
3. **Book the follow-up before the call ends.** Three days out. Without it you
   will get silence and not know whether that means "working" or "gave up".

At the follow-up, open the activity log together and go through what it caught.
The question worth asking is not "is it working" but **"is there anything in
here you'd have been unhappy to block?"**

---

## What to watch, in priority order

1. **False positives.** The single thing that matters. A blocked real customer
   is worse than a hundred admitted scrapers, because the founder will not find
   out from a dashboard — they will find out from a support ticket, and they
   will blame you correctly. Watch `bots` blocks with a low `bot_score`, and any
   `tpm.missing` on document requests.
2. **Search traffic.** Check Search Console with them at day 7. Verified
   crawlers are allowed by default; confirm it is actually working.
3. **Setup drop-off.** Anyone stuck at DNS verification for more than a day has
   hit something the instructions do not cover. That is a docs bug, not a user
   error.
4. **Whether they ever open the evidence log.** If nobody does, the legal
   tooling is not the product and the pricing is wrong.

---

## Things that will go wrong, and the answer

**"My site went down."** Check `x-foundershield` on the response. `degraded`
means our layer errored and passed through — their site was served. `blocked`
means we refused. If the origin is unreachable the proxy returns 502, which
looks like our fault and is worth checking before assuming it is.

**"Legitimate users are being blocked."** Put them back in `monitor` mode
immediately, then diagnose. Do not defend the score. Add the user agent to the
allowlist as a stopgap and treat the underlying rule as a bug to fix.

**"Googlebot is blocked."** `allowVerifiedBots` should be on. If it is, we are
relying on Cloudflare's `verifiedBotCategory` — see the known gap below.

**"It's slow."** Edge decisions add roughly a millisecond and the origin fetch
dominates. If they see real latency it is likely the origin URL routing through
somewhere unexpected. Check `origin_ms` in the activity log; it is recorded per
request precisely for this.

**"Can I sue them?"** Give them the evidence report and the name of a lawyer.
Do not answer this question yourself, however much you have read.

---

## Known gaps to disclose up front

Do not let a beta user discover these on their own:

- **Search crawler verification is inherited, not independent.** We trust
  Cloudflare's `verifiedBotCategory` rather than doing our own reverse-DNS
  check. Good enough, but it is not our own verification.
- **Evidence seals are self-generated.** They prove internal consistency, not
  that the data was true when written. No external timestamping yet.
- **Signing is a record of assent, not a qualified e-signature.** Fine for
  contractor NDAs; not a DocuSign replacement.
- **Request counts are estimates.** Ordinary traffic is sampled. This is why
  allowances are advisory and nothing is ever throttled.
- **Not yet deployed at scale.** Say the number of domains currently running.

---

## When to stop being a beta

Not on a date. When all of these are true:

- [ ] Five users have run in `standard` or `strict` for two weeks.
- [ ] Zero unresolved false-positive reports.
- [ ] At least one user has exported evidence and found it useful.
- [ ] Nobody has needed you to intervene manually for a week.

If the third one never happens, the legal tooling is not the product and the
pricing needs rethinking before launch, not after.
