/**
 * Notice and demand drafting.
 *
 * Three documents, deliberately kept distinct because they rest on different
 * facts and are sent to different people. Conflating them is the most common
 * way a founder sends something that does nothing except create exposure.
 *
 *   dmca-512       To a *host*, about material republished on their system.
 *                  Rests on the republication, not on access logs.
 *   circumvention  To an *actor*, about bypassing access controls on your own
 *                  site. Rests on the evidence log.
 *   access         To an *actor*, about accessing gated routes without
 *                  authorisation, or in breach of accepted terms.
 *
 * Nothing here sends anything. Every generator produces a draft for a human to
 * read, edit and decide about. That is not timidity — a § 512 notice is sworn
 * under penalty of perjury, and 17 U.S.C. § 512(f) creates liability for a
 * knowing material misrepresentation. Software cannot hold a good-faith belief,
 * so software must not assert one.
 */

export type NoticeKind = 'dmca-512' | 'circumvention' | 'access';

export interface NoticeDocument {
  kind: NoticeKind;
  title: string;
  /** Suggested recipient, e.g. "the designated agent of Example Host Inc." */
  addressee: string;
  subject: string;
  body: string;
  /** Things the sender must check before this goes anywhere. */
  cautions: string[];
}

export type NoticeResult =
  | { ok: true; document: NoticeDocument; cautions: string[] }
  | { ok: false; missing: string[] };

function bullets(items: readonly string[]): string {
  return items.map((item) => `  - ${item}`).join('\n');
}

// ---------------------------------------------------------------------------
// DMCA section 512 takedown
// ---------------------------------------------------------------------------

export interface DmcaInput {
  /** Person signing. A § 512 notice must be signed by a natural person. */
  signatoryName: string;
  signatoryTitle: string;
  signatoryEmail: string;
  signatoryPhone: string;
  signatoryAddress: string;
  /** Rights holder, if not the signatory personally. */
  rightsHolder: string;

  /** What was copied, and where the original lives. */
  workDescription: string;
  originalUrls: string[];

  /** Where the copy is. Must be on the recipient's system. */
  infringingUrls: string[];
  /** The host or platform being notified. */
  serviceProvider: string;

  /**
   * The three statements § 512(c)(3)(A) requires. These are assertions about
   * the sender's state of mind and are never defaulted to true.
   */
  goodFaithBelief: boolean;
  accuracyStatement: boolean;
  authorityStatement: boolean;
}

/**
 * Refuses to draft unless every statutory element is present.
 *
 * This is the point of the function. An incomplete notice does not trigger the
 * provider's obligation under § 512(c)(1)(C) anyway, so a partial draft is
 * worse than none: it looks like progress while achieving nothing, and invites
 * the sender to fill the gaps with guesses that later read as misrepresentation.
 */
export function generateDmcaNotice(input: DmcaInput): NoticeResult {
  const missing: string[] = [];

  if (!input.signatoryName.trim()) missing.push('The name of the person signing the notice.');
  if (!input.signatoryEmail.trim() && !input.signatoryPhone.trim()) {
    missing.push('Contact details for the signatory — section 512(c)(3)(A)(iv) requires an address, telephone number or email.');
  }
  if (!input.workDescription.trim()) {
    missing.push('A description of the copyrighted work you say has been infringed.');
  }
  if (input.originalUrls.filter(Boolean).length === 0) {
    missing.push('At least one location of your original work, so the recipient can compare.');
  }
  if (input.infringingUrls.filter(Boolean).length === 0) {
    missing.push('The specific URL or URLs of the infringing material on the recipient’s system.');
  }
  if (!input.serviceProvider.trim()) missing.push('The host or platform you are notifying.');
  if (!input.goodFaithBelief) {
    missing.push('Your statement of good-faith belief that the use is not authorised by the rights holder, an agent, or the law.');
  }
  if (!input.accuracyStatement) {
    missing.push('Your statement, under penalty of perjury, that the information in the notice is accurate.');
  }
  if (!input.authorityStatement) {
    missing.push('Your statement, under penalty of perjury, that you are authorised to act for the rights holder.');
  }

  if (missing.length > 0) return { ok: false, missing };

  const holder = input.rightsHolder.trim() || input.signatoryName.trim();
  const contact = [input.signatoryAddress, input.signatoryEmail, input.signatoryPhone].filter(Boolean).join('\n');

  const body = `To the designated copyright agent of ${input.serviceProvider}:

I am writing to notify you of material on your system that infringes copyright owned by ${holder}, and to request its removal or the disabling of access to it under 17 U.S.C. § 512(c).

1. The copyrighted work

${input.workDescription.trim()}

The original work can be found at:
${bullets(input.originalUrls.filter(Boolean))}

2. The infringing material

The material I am asking you to remove or disable access to is located at:
${bullets(input.infringingUrls.filter(Boolean))}

3. Contact details

${contact}

4. Statements required by 17 U.S.C. § 512(c)(3)(A)

I have a good faith belief that use of the material in the manner complained of is not authorized by the copyright owner, its agent, or the law.

I swear, under penalty of perjury, that the information in this notification is accurate and that I am the copyright owner, or am authorized to act on behalf of the owner, of an exclusive right that is allegedly infringed.

${input.signatoryName}${input.signatoryTitle ? `\n${input.signatoryTitle}` : ''}${input.rightsHolder ? `\nFor and on behalf of ${input.rightsHolder}` : ''}
Date: ____________`;

  return {
    ok: true,
    cautions: [
      'Read every URL you have listed and confirm the material is actually there and actually yours. The accuracy statement is sworn under penalty of perjury.',
      'Consider whether the use might be fair use, licensed, or otherwise permitted. Section 512(f) creates liability for knowingly misrepresenting that material is infringing, and a notice sent without considering fair use has been held to fall short.',
      'Send this to the provider’s designated agent, whose details are registered with the US Copyright Office. A notice sent to a general contact address may not count.',
      'The recipient may pass your contact details to the person who posted the material, and that person may file a counter-notice.',
      'Have a lawyer read this before you send it.',
    ],
    document: {
      kind: 'dmca-512',
      title: 'Notification of claimed infringement under 17 U.S.C. § 512(c)',
      addressee: `Designated copyright agent, ${input.serviceProvider}`,
      subject: `Notification of claimed infringement — ${input.workDescription.trim().slice(0, 60)}`,
      body,
      cautions: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Demands built from the evidence log
// ---------------------------------------------------------------------------

export interface IncidentSummary {
  ip: string;
  firstSeen: string;
  lastSeen: string;
  requests: number;
  blocked: number;
  peakPerMinute: number;
  distinctPaths: number;
  bytesServed: number;
  userAgents: string[];
  ruleIds: string[];
  asOrganisation?: string | null;
  country?: string | null;
}

export interface DemandInput {
  senderName: string;
  senderEntity: string;
  senderEmail: string;
  domain: string;
  recipientDescription: string;
  incidents: IncidentSummary[];
  /** Whether the site was showing a terms gate during the period. */
  termsInForce: boolean;
  termsVersion?: string;
  /** Whether the routes touched were behind an authorisation gate. */
  gatedRoutes: boolean;
  periodFrom: string;
  periodTo: string;
}

function describeIncident(incident: IncidentSummary): string {
  const parts = [
    `${incident.ip}${incident.asOrganisation ? ` (${incident.asOrganisation}${incident.country ? `, ${incident.country}` : ''})` : ''}`,
    `${incident.requests.toLocaleString()} requests between ${incident.firstSeen} and ${incident.lastSeen}`,
    `${incident.blocked.toLocaleString()} refused by access controls`,
    `peak rate ${incident.peakPerMinute} requests per minute`,
    `${incident.distinctPaths.toLocaleString()} distinct paths`,
  ];
  if (incident.userAgents.length > 0) {
    parts.push(`presenting: ${incident.userAgents.slice(0, 3).join('; ')}`);
  }
  return parts.join('\n    ');
}

/** Common preamble for both evidence-based demands. */
function evidenceBlock(input: DemandInput): string {
  return `Between ${input.periodFrom} and ${input.periodTo}, systems protecting ${input.domain} recorded the following activity:

${input.incidents.map((incident) => `  - ${describeIncident(incident)}`).join('\n\n')}

These records were generated automatically at the time of each request by the access control layer in front of ${input.domain}. They are retained in append-only storage and are hash-sealed against later alteration. Full records are available.`;
}

export function generateCircumventionDemand(input: DemandInput): NoticeResult {
  const missing: string[] = [];
  if (!input.senderName.trim()) missing.push('The name of the person sending the demand.');
  if (!input.domain.trim()) missing.push('The domain the activity was directed at.');
  if (input.incidents.length === 0) missing.push('At least one recorded incident to describe.');
  if (missing.length > 0) return { ok: false, missing };

  const circumventionRules = input.incidents.flatMap((i) => i.ruleIds).filter((id) => id.startsWith('tpm.'));
  const forged = circumventionRules.some((id) => id === 'tpm.bad_signature' || id === 'tpm.binding_mismatch');

  const body = `To ${input.recipientDescription || 'the operator of the systems identified below'}:

I write on behalf of ${input.senderEntity || input.senderName} concerning automated access to ${input.domain}.

1. The access controls in place

Access to ${input.domain} is controlled. Before content is served, the site requires a client to complete a verification step and to present a valid, short-lived, cryptographically signed access token. Requests without a valid token are refused.${input.gatedRoutes ? ' Certain routes are additionally restricted to authenticated sessions.' : ''}${input.termsInForce ? ` The site also requires visitors to accept its terms of use${input.termsVersion ? ` (version ${input.termsVersion})` : ''} before access is given.` : ''}

2. What was recorded

${evidenceBlock(input)}

3. Why I am writing

${
  forged
    ? 'The records show requests carrying access tokens that did not verify against the signing key in use. A token in that state is not one this site issued: it was constructed. That is not incidental to the access — it is a deliberate attempt to defeat the measure that controls it.'
    : 'The volume, rate and pattern of this activity is not consistent with ordinary use of the site by a person, and the access controls described above refused it.'
}

I ask that you:

  - stop all automated access to ${input.domain};
  - confirm in writing that you have done so;
  - confirm what data obtained from ${input.domain} you hold, and delete it;
  - confirm that no data obtained from ${input.domain} has been used to train, fine-tune or evaluate any model, or supplied to any third party.

Please respond by email to ${input.senderEmail || '[your email]'} within 14 days.

This letter is not a waiver of any right or remedy, all of which are reserved.

${input.senderName}${input.senderEntity ? `\n${input.senderEntity}` : ''}
Date: ____________`;

  const cautions = [
    'This letter describes what your systems observed. Whether that activity is unlawful is a separate question, and this draft does not decide it.',
    'A network address identifies a connection, not a person or a company. Confirm who you are actually writing to before you send it.',
    'Anti-circumvention claims under 17 U.S.C. § 1201 are contested as applied to bot mitigation, and require a nexus to a copyrighted work. Do not assert a violation in correspondence without advice.',
    'Have a lawyer read this before you send it.',
  ];

  if (!forged) {
    cautions.unshift(
      'None of the recorded incidents show a forged or lifted access token — only requests that had not completed verification. That is materially weaker than circumvention, and the letter is worded accordingly. Consider whether an access or terms-based demand fits these facts better.',
    );
  }

  return {
    ok: true,
    cautions,
    document: {
      kind: 'circumvention',
      title: 'Demand — circumvention of access controls',
      addressee: input.recipientDescription || 'Operator of the identified systems',
      subject: `Automated access to ${input.domain}`,
      body,
      cautions: [],
    },
  };
}

export function generateAccessDemand(input: DemandInput): NoticeResult {
  const missing: string[] = [];
  if (!input.senderName.trim()) missing.push('The name of the person sending the demand.');
  if (!input.domain.trim()) missing.push('The domain the activity was directed at.');
  if (input.incidents.length === 0) missing.push('At least one recorded incident to describe.');
  if (missing.length > 0) return { ok: false, missing };

  const gateRules = input.incidents.flatMap((i) => i.ruleIds).filter((id) => id.startsWith('gate.'));
  const hitGatedRoutes = gateRules.length > 0;

  const body = `To ${input.recipientDescription || 'the operator of the systems identified below'}:

I write on behalf of ${input.senderEntity || input.senderName} concerning access to ${input.domain}.

1. The basis on which access is given

${
  input.termsInForce
    ? `Access to ${input.domain} is granted on the terms of use published at that domain${input.termsVersion ? `, version ${input.termsVersion}` : ''}. Visitors are shown those terms and must accept them before access is given. The terms prohibit automated collection of content and prohibit its use for training machine learning models.`
    : `Access to ${input.domain} is subject to its published terms of use, which prohibit automated collection of its content.`
}${
    input.gatedRoutes
      ? ` In addition, parts of the site are closed to unauthenticated requests and are served only to signed-in users.`
      : ''
  }

2. What was recorded

${evidenceBlock(input)}

3. Why I am writing

${
  hitGatedRoutes
    ? 'The records include requests directed at routes that are closed to unauthenticated access. Those routes are not published: they are gated, and the requests were refused.'
    : 'This activity is inconsistent with the basis on which access to the site is given.'
}

I ask that you:

  - stop all automated access to ${input.domain};
  - confirm in writing that you have done so;
  - confirm what data obtained from ${input.domain} you hold, and delete it;
  - confirm that no data obtained from ${input.domain} has been used to train, fine-tune or evaluate any model, or supplied to any third party.

Please respond by email to ${input.senderEmail || '[your email]'} within 14 days.

This letter is not a waiver of any right or remedy, all of which are reserved.

${input.senderName}${input.senderEntity ? `\n${input.senderEntity}` : ''}
Date: ____________`;

  const cautions = [
    'A network address identifies a connection, not a person or a company. Confirm who you are actually writing to before you send it.',
    'Have a lawyer read this before you send it.',
  ];

  if (!hitGatedRoutes) {
    cautions.unshift(
      'None of the recorded incidents involve routes behind an authorisation gate — the activity was against openly served pages. After hiQ v. LinkedIn, scraping publicly available data is generally not access "without authorization" under the CFAA, so this letter rests on your terms of use rather than on that statute, and is worded that way.',
    );
  }

  if (!input.termsInForce) {
    cautions.unshift(
      'The site was not requiring acceptance of terms during this period, so there is no record that this actor agreed to anything. A demand resting on breach of terms is considerably weaker without that.',
    );
  }

  return {
    ok: true,
    cautions,
    document: {
      kind: 'access',
      title: 'Demand — unauthorised access and breach of terms',
      addressee: input.recipientDescription || 'Operator of the identified systems',
      subject: `Access to ${input.domain}`,
      body,
      cautions: [],
    },
  };
}
