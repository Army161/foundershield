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

**What the code does about it.** The terms version is a *hash of the rendered
text* ([`packages/shared/src/terms.ts`](../packages/shared/src/terms.ts)), not a
number someone types. Editing any clause changes the version, which invalidates
every prior acceptance and re-asks the visitor. It is therefore not possible to
alter the terms someone agreed to while still holding a record saying they
agreed to the current ones — which is precisely the attack on clickwrap that
succeeds most often.

**The presentation choice matters more than it looks.** `interstitial` withholds
the page until the visitor clicks. `modal` serves the page and overlays a
notice. Only the first controls access: under `modal` the content has already
left the server, so a client that ignores the overlay and reads the DOM has it.
Modal mode supports contract formation and nothing else, the dashboard says so
in those words, and the proxy refuses to let modal mode relax a TPM or bot
challenge — that combination still withholds the page.

The limitation is that a contract binds the party who accepted it. It reaches an
automated client that clicked through; it reaches an operator who never loaded
the page far less well.

**The AI-training clause** is an express reservation of rights and refusal of
text and data mining, published in three places that must agree: the terms, the
`/.well-known/ai-permissions.json` document, and (opt-in) `robots.txt`. All
three derive from the same settings, so they cannot drift apart and leave a
crawler operator able to say it read the permissive one. Note the honest limit:
publishing a refusal is not the same as it being honoured, and the legal weight
of a machine-readable reservation is still developing — the EU AI Act's Article
53 obligations are the clearest hook and they bind AI providers, not the sites
they crawl.

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

**What the code does about it.** `actor_burden()` aggregates per address:
requests, bytes served, origin time consumed, active span, distinct paths, and
peak requests-per-minute. Peak rate is the one that distinguishes a burst from a
trickle, and it is the figure most likely to matter.

Read the output honestly. A scraper pulling 40 requests in a minute and
consuming a second of origin time has not impaired anything, and the report will
show exactly that. The value of these numbers is as much in ruling the theory
*out* cheaply as in supporting it — which is why the evidence report prints them
plainly rather than editorialising.

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

## Layer 6 — Confidentiality agreements (`agreements`)

**What it does.** Generates an NDA, issues signing links, and records assent
against a specific document version.
[`packages/shared/src/nda.ts`](../packages/shared/src/nda.ts).

**Theory:** DTSA, 18 U.S.C. § 1836. Trade secret status requires the owner to
have taken "reasonable measures" to keep the information secret.

**Honest assessment.** Solid, and unusually actionable: unlike the statutes
above, this one tells you exactly what to do. The measure is the NDA, and its
absence is the usual reason a trade secret claim fails before anyone reaches the
merits.

One specific thing this gets right that most templates do not: § 1833(b)(3)
requires an agreement governing trade secret use to contain a notice of the
whistleblower immunity in § 1833(b). Omit it and you forfeit exemplary damages
and attorney's fees against that person under § 1836(b)(3)(C)-(D). The generator
includes it, defaults it on for US governing law, and `reviewNda()` warns when
it is off — naming the specific remedies at stake rather than saying "consider
adding a notice".

**Limits, stated plainly.** The signature record is a timestamped record of
assent with a hash of the exact text — the same construction as the clickwrap
record, and no stronger. It is not a qualified or advanced electronic signature
under eIDAS, and it is not a notarised execution. For an agreement where
execution formality actually matters, use a real e-signature provider.

---

## The notice tooling

Not a layer — a drafting aid sitting on top of the layers above. It exists in
its current form because of rule 2 below, not despite it.

**What it will not do.** It does not send. It does not tick a statutory
statement for you, and there is no configuration that makes it. A § 512 notice
carries two statements sworn under penalty of perjury, and § 512(f) creates
liability for knowingly misrepresenting that material is infringing — including,
per *Lenz v. Universal*, where fair use was not considered. Software cannot hold
a good-faith belief. So the checkboxes start unticked, and
`generateDmcaNotice()` returns a list of what is missing rather than a draft
with gaps in it: an incomplete notice does not trigger the provider's obligation
under § 512(c)(1)(C) anyway, so a partial draft is worse than none.

**Why the split.** "Generate DMCA notices from proxy logs" is a category error.
§ 512 targets material residing on a *service provider's* system; access logs
evidence traffic to *your own*. They are different documents to different
recipients resting on different facts, so they are separate generators.

**Each demand reads its own evidence and reports weakness.** The circumvention
letter checks for `tpm.bad_signature` or `tpm.binding_mismatch` — an actually
forged or lifted token. Absent that, it softens its own wording and tells the
sender the facts are materially weaker than circumvention. The access letter
checks whether any `gate.*` rule fired; if the traffic only touched openly
served pages, it cites *hiQ* back at the sender and rests on the terms of use
instead. Both refuse to draft with no incidents at all.

This is the honest version of the feature. A tool that produced a confident
letter from thin facts would be actively harmful to the person sending it.

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
2. **Never send a legal demand automatically, and never assert a state of mind
   on the sender's behalf.** Drafting is a legitimate aid and Phase 3 builds it.
   Sending is not, and the sworn statements in a § 512 notice are the sender's
   alone — a pre-ticked good-faith checkbox is exactly what § 512(f) exposure
   looks like. Draft, warn, and stop.
3. **Keep observation separate from interpretation** in the schema, the exports
   and the UI. The moment they blur, the log stops being a record and starts
   being an argument.
4. **Do not claim the log is immutable.** It is append-only and tamper-evident.
   Those are different words and the difference is the honest one.
