# What each technical measure actually does, legally

This document maps every enforcement layer to the legal theory it is meant to
support, and states plainly how strong that support is. It exists because the
gap between "we built a bot blocker" and "bypassing this is a federal crime" is
where a product like this gets itself into trouble — both by over-promising to
customers and by mis-setting their expectations in a real dispute.

**Nothing here is legal advice.** It is an engineering document describing what
the system records and what that evidence can and cannot establish.

---

## The one-paragraph version

FounderShield's genuine, defensible value is **evidence**: a contemporaneous,
tamper-evident, machine-generated record of who accessed what, what access
controls were in place at the time, and what those controls did. That record is
hard to reconstruct after the fact and is useful under *any* legal theory. The
statutory hooks below are real, but each is contested in ways the marketing
should not paper over.

---

## Layer 1 — Browser verification (`tpm`)

**What it does.** Issues a signed, short-lived, rolling-key token only to a
client that has executed a proof-of-work challenge in a real JavaScript
environment. Requests without a valid token are refused. Implemented in
[`packages/shared/src/token.ts`](../packages/shared/src/token.ts).

**Theory:** DMCA § 1201(a)(1)(A) — circumventing a technological measure that
effectively controls access to a copyrighted work.

**Honest assessment.**

- *Ticketmaster v. RMG* (C.D. Cal. 2007) did treat CAPTCHA bypass as
  circumvention, and it is the case everyone cites. It is a district court
  decision from a preliminary-injunction posture, not binding precedent
  anywhere.
- § 1201 requires a nexus to a **copyrighted work**. A measure guarding a page
  of original prose or images sits far better than one guarding, say, a table of
  prices or purely factual data, which may attract thin or no copyright.
- Several courts have required that a measure "effectively control access" in a
  more-than-trivial sense. A rate limiter almost certainly does not qualify. A
  cryptographic challenge that must be affirmatively solved is a much better
  candidate — which is why this layer is built the way it is rather than as a
  header check.
- The "strips fair use" claim is half right and worth stating precisely: fair
  use is a defence to *infringement*, and § 1201(a)(1) circumvention is a
  separate wrong, so fair use does not answer a circumvention claim directly.
  Courts remain divided on how far that separation goes.

**What the code does about it.** The evidence log distinguishes *no token yet*
(`tpm.missing` — recorded, recoverable, challenged) from *a token that was
constructed* (`tpm.bad_signature` — blocked). Only the second is evidence that
somebody built something to get around the measure. That distinction is the
whole point of the layer, and it is why the two are never collapsed into one
"blocked" bucket.

---

## Layer 2 — Authorisation boundary (`authgate`)

**What it does.** Closes named routes unless the request satisfies a stated
condition (session cookie, issued API key, IP allowlist, accepted terms, or
outright deny). See [`packages/edge/src/layers.ts`](../packages/edge/src/layers.ts).

**Theory:** CFAA, 18 U.S.C. § 1030 — access "without authorization".

**Honest assessment.** This is the strongest layer in the stack, and it is
strong *precisely because* of the cases that narrowed the CFAA:

- *hiQ v. LinkedIn* (9th Cir. 2022) held that scraping **public** data is not
  access without authorization. Read correctly, this is not bad news — it is a
  map. It tells you exactly what to build: a gate.
- *Van Buren* (2021) narrowed "exceeds authorized access" to a gates-based test.
  Again: build the gate.

The consequence for the product is direct — **content that sits behind no gate
gets no CFAA protection, no matter how many other layers are switched on.** The
Protected Routes tab is therefore the highest-value screen in the dashboard, not
a secondary feature, and the UI says so.

A caveat worth being honest about: a terms-of-service prohibition alone is not a
technical gate, and post-*hiQ* it is thin ground on its own.

---

## Layer 3 — Terms acceptance (`clickwrap`)

**What it does.** Withholds content until the visitor clicks "I agree", then
records a signed, timestamped, versioned acceptance.

**Theory:** Contract. Breach of an accepted agreement.

**Honest assessment.** Genuinely solid, and the least contested item here.
Clickwrap (affirmative click) is routinely enforced; browsewrap (a footer link)
routinely is not. This layer implements clickwrap specifically, and versions
acceptance so amended terms require fresh assent — a common failure point when
terms are updated silently.

The limitation is that a contract binds the party who accepted it. It reaches an
automated client that clicked through; it reaches an operator who never loaded
the page far less well.

---

## Layer 4 — Rate limiting and the request log (`ratelimit`)

**What it does.** Bounds request rate per client and records volume, timing and
response size.

**Theory:** Trespass to chattels.

**Honest assessment.** The weakest theory in the stack, and the docs should not
imply otherwise. *Intel v. Hamidi* (Cal. 2003) requires actual **impairment** to
the system, not merely unauthorised contact. Most scraping — even aggressive
scraping — does not measurably impair a modern host, and a plaintiff who cannot
show impairment generally loses.

This is why the schema records `origin_ms`, `response_bytes` and request
volume: if impairment ever *is* provable, these are the numbers that prove it.
If it is not, no amount of logging manufactures it.

---

## Layer 5 — Automation detection (`bots`)

**Theory:** none, standing alone.

Header-based scoring is an operational control, not a legal instrument. Its
evidential value is contextual: it shows what the operator knew and when. Note
that a client which *self-identifies* as a bot (`curl`, `Scrapy`, `GPTBot`) is
evidence of the opposite of concealment — worth remembering before characterising
intent. The rule descriptions in
[`packages/shared/src/bots.ts`](../packages/shared/src/bots.ts) are written to be
quotable in an exhibit without editing, and deliberately describe observations
rather than conclusions.

---

## Evidence integrity

Anyone can produce a CSV. What makes a log credible is that it was generated
contemporaneously by a system, in the ordinary course, and has not been edited
since.

The schema supports that:

- **Append-only by grant.** `authenticated` and `anon` have no `UPDATE` or
  `DELETE` privilege on `request_events`; only the edge worker's service role
  writes. Not a convention — a revoked grant.
- **Per-row hash at insert.** A trigger hashes the immutable observation columns.
- **Chained seals.** `seal_evidence()` fixes a closed range and chains to the
  previous seal, so a later edit, insertion or deletion inside a sealed range
  changes the digest. `verify_evidence_seal()` re-derives and compares.
- **Independent corroboration.** Cloudflare Ray ID and colo are recorded, so the
  network operator's own records can corroborate ours.

**Limitation, stated plainly:** these seals are self-generated. They prove
internal consistency, not that the data was true when written. A seal created
*before* a dispute arises is worth considerably more than one created after, and
the UI says so. For anything high-stakes, an external timestamping authority or
periodic off-site export is the next step up, and is not implemented here.

---

## Rules the product should hold itself to

1. **Never state in customer-facing copy that bypassing FounderShield "is a
   federal crime."** It may support a claim. Whether it is one is for a court.
   Overclaiming here is itself a false-advertising exposure, and it is the
   customer who would be relying on it.
2. **Never generate a legal demand automatically.** Generating the *evidence
   pack* is the product; deciding to send a threat is a lawyer's call. A
   mis-sent DMCA notice carries § 512(f) exposure for the sender.
3. **Keep observation separate from interpretation** in the schema, the exports
   and the UI. The moment they blur, the log stops being a record and starts
   being an argument.
4. **Do not claim the log is immutable.** It is append-only and tamper-evident.
   Those are different words and the difference is the honest one.
