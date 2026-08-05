/**
 * Non-disclosure agreement generation.
 *
 * The DTSA angle is why this exists. Trade secret protection under 18 U.S.C.
 * § 1836 is conditional on the owner having taken "reasonable measures" to keep
 * the information secret — an NDA with everyone who sees it is the canonical
 * measure, and its absence is the usual reason a trade secret claim fails
 * before anyone argues the merits.
 *
 * One detail is worth more than the rest of this file: 18 U.S.C. § 1833(b)(3)
 * requires that any agreement governing the use of a trade secret contain a
 * notice of the whistleblower immunity in § 1833(b). Omit it and you forfeit
 * exemplary damages and attorney's fees under § 1836(b)(3)(C)-(D) against that
 * person — the two remedies most worth having. Most templates omit it. This one
 * includes it, conditionally on US governing law, and the dashboard explains
 * why rather than leaving it as unexplained boilerplate.
 *
 * As with the terms generator: a template, not legal advice, and versioned by
 * content hash so a signature always records exactly what was signed.
 */

import { sha256 } from './crypto';
import { toHex, utf8 } from './encoding';

export interface NdaInput {
  /** The party sharing confidential information. */
  disclosingParty: string;
  disclosingAddress: string;
  /** The party receiving it. May be blank on an unissued template. */
  receivingParty: string;
  /** Both parties may disclose, rather than only one. */
  mutual: boolean;
  /** Why the information is being shared, e.g. "a contract engineering engagement". */
  purpose: string;
  jurisdiction: string;
  effectiveDate: string;
  /** How long the confidentiality obligation runs for non-trade-secret material. */
  termYears: number;
  /** Trade secrets stay protected for as long as they remain secret. */
  perpetualForTradeSecrets: boolean;
  /** Include the 18 U.S.C. 1833(b) immunity notice. Required for US agreements. */
  includeDtsaNotice: boolean;
  contactEmail: string;
}

export interface NdaSection {
  id: string;
  heading: string;
  paragraphs: string[];
}

export interface GeneratedNda {
  version: string;
  title: string;
  effectiveDate: string;
  sections: NdaSection[];
}

export const DEFAULT_NDA_INPUT: NdaInput = {
  disclosingParty: '',
  disclosingAddress: '',
  receivingParty: '',
  mutual: false,
  purpose: 'evaluating and performing a potential working relationship',
  jurisdiction: 'England and Wales',
  effectiveDate: new Date(0).toISOString().slice(0, 10),
  termYears: 3,
  perpetualForTradeSecrets: true,
  includeDtsaNotice: false,
  contactEmail: '',
};

/**
 * Whether the DTSA notice is applicable. US federal law, so it turns on the
 * governing law rather than on where either party happens to sit.
 */
export function looksLikeUsJurisdiction(jurisdiction: string): boolean {
  const value = jurisdiction.toLowerCase();
  if (/\b(england|wales|scotland|northern ireland|united kingdom|singapore|ireland|australia|canada|india|germany|france|netherlands)\b/.test(value)) {
    return false;
  }
  return /\b(united states|u\.?s\.?a?\b|delaware|california|new york|texas|washington|massachusetts|federal)\b/.test(value);
}

function buildSections(input: NdaInput): NdaSection[] {
  const disclosing = input.disclosingParty || '[Disclosing party]';
  const receiving = input.receivingParty || '[Receiving party]';
  const sections: NdaSection[] = [];

  const partyDescription = input.mutual
    ? `Each party may disclose confidential information to the other. In this agreement, the party disclosing information is the "Discloser" and the party receiving it is the "Recipient"; both parties act in both capacities.`
    : `${disclosing} ("Discloser") may disclose confidential information to ${receiving} ("Recipient"). Only ${disclosing} discloses under this agreement.`;

  sections.push({
    id: 'parties',
    heading: '1. Parties and purpose',
    paragraphs: [
      `This agreement is made between ${disclosing}${input.disclosingAddress ? ` of ${input.disclosingAddress}` : ''} and ${receiving}, and takes effect on ${input.effectiveDate}.`,
      partyDescription,
      `Information is being shared for the purpose of ${input.purpose} (the "Purpose"). Recipient may use it for the Purpose and for nothing else.`,
    ],
  });

  sections.push({
    id: 'definition',
    heading: '2. What is confidential',
    paragraphs: [
      '"Confidential Information" means any non-public information Discloser shares with Recipient, in any form, whether or not it is marked as confidential. It includes source code, algorithms, models, architecture, database schemas, security arrangements, unreleased features, product plans, pricing, financial information, customer and supplier information, and the existence and contents of discussions between the parties.',
      'It also includes anything Recipient derives from that information, including notes, analyses, summaries and copies.',
      'Information does not stop being confidential because it was shared verbally or was not labelled.',
    ],
  });

  sections.push({
    id: 'exclusions',
    heading: '3. What is not confidential',
    paragraphs: [
      'Confidential Information does not include information that Recipient can show: (a) was already public, or became public through no act or omission of Recipient; (b) Recipient already held, without any obligation of confidence, before Discloser shared it; (c) Recipient rightfully received from a third party who was free to share it; or (d) Recipient independently developed without using or referring to Confidential Information.',
      'Recipient bears the burden of showing that one of these applies, by contemporaneous written records.',
    ],
  });

  sections.push({
    id: 'obligations',
    heading: '4. Recipient’s obligations',
    paragraphs: [
      'Recipient will keep Confidential Information secret, will use it only for the Purpose, and will not disclose it to anyone except as this agreement allows.',
      'Recipient will protect it with at least the care it uses for its own confidential information, and in no case less than reasonable care.',
      'Recipient may share it with its own employees, contractors and professional advisers who need it for the Purpose, but only if they are bound by confidentiality obligations at least as protective as these. Recipient remains responsible for their compliance.',
      'Recipient will not reverse engineer, decompile or disassemble anything Discloser provides, and will not use Confidential Information to develop anything that competes with Discloser.',
      'Recipient will not use Confidential Information to train, fine-tune or evaluate any machine learning model, and will not supply it to any third party for that purpose.',
      'Recipient will tell Discloser promptly if it learns of any unauthorised use or disclosure, and will help Discloser address it.',
    ],
  });

  sections.push({
    id: 'compelled',
    heading: '5. Disclosure required by law',
    paragraphs: [
      'If Recipient is required by law, regulation or court order to disclose Confidential Information, it may do so, but only to the extent required.',
      'Where it is lawful to do so, Recipient will tell Discloser first and in enough time for Discloser to seek a protective order, and will cooperate reasonably with any such effort.',
    ],
  });

  const survival = input.perpetualForTradeSecrets
    ? `These obligations run for ${input.termYears} year${input.termYears === 1 ? '' : 's'} from the date the relevant information was disclosed. For anything that qualifies as a trade secret, they continue for as long as it remains a trade secret, which may be indefinitely.`
    : `These obligations run for ${input.termYears} year${input.termYears === 1 ? '' : 's'} from the date the relevant information was disclosed.`;

  sections.push({
    id: 'term',
    heading: '6. How long this lasts',
    paragraphs: [
      survival,
      'Either party may end the discussions this agreement supports at any time. Ending them does not end the confidentiality obligations.',
    ],
  });

  sections.push({
    id: 'return',
    heading: '7. Return and destruction',
    paragraphs: [
      'On Discloser’s written request, Recipient will promptly return or destroy all Confidential Information and everything derived from it, and confirm in writing that it has done so.',
      'Recipient may keep one copy to the extent required by law or by its own document retention policy, and may keep material held in routine backups it cannot practically isolate. Anything kept stays subject to this agreement for as long as it is kept.',
    ],
  });

  sections.push({
    id: 'no-rights',
    heading: '8. No rights granted',
    paragraphs: [
      'Confidential Information stays Discloser’s. This agreement does not transfer or license any patent, copyright, trade secret, trade mark or other right, and does not oblige either party to enter into any further agreement.',
      'Discloser gives no warranty that Confidential Information is accurate or complete.',
    ],
  });

  sections.push({
    id: 'remedies',
    heading: '9. Remedies',
    paragraphs: [
      'Recipient accepts that unauthorised use or disclosure of Confidential Information may cause Discloser harm that damages alone cannot adequately remedy, and that Discloser may seek an injunction or other equitable relief in addition to any other remedy available to it.',
      'Neither party waives any right by not exercising it immediately.',
    ],
  });

  if (input.includeDtsaNotice) {
    sections.push({
      id: 'dtsa-immunity',
      heading: '10. Notice of immunity under the Defend Trade Secrets Act',
      paragraphs: [
        'This notice is given under 18 U.S.C. § 1833(b).',
        'An individual shall not be held criminally or civilly liable under any Federal or State trade secret law for the disclosure of a trade secret that: (a) is made (i) in confidence to a Federal, State, or local government official, either directly or indirectly, or to an attorney; and (ii) solely for the purpose of reporting or investigating a suspected violation of law; or (b) is made in a complaint or other document filed in a lawsuit or other proceeding, if such filing is made under seal.',
        'An individual who files a lawsuit for retaliation by an employer for reporting a suspected violation of law may disclose the trade secret to the attorney of the individual and use the trade secret information in the court proceeding, if the individual: (a) files any document containing the trade secret under seal; and (b) does not disclose the trade secret, except pursuant to court order.',
        'Nothing in this agreement limits or contradicts this immunity, and nothing in it should be read as discouraging a report of a suspected violation of law.',
      ],
    });
  }

  sections.push({
    id: 'general',
    heading: `${input.includeDtsaNotice ? '11' : '10'}. General`,
    paragraphs: [
      `This agreement is governed by the law of ${input.jurisdiction}, and the courts of ${input.jurisdiction} have jurisdiction over any dispute arising from it.`,
      'This is the entire agreement between the parties about confidentiality, and replaces any earlier understanding on that subject. It can only be changed in writing signed by both parties.',
      'If any part of this agreement is unenforceable, the rest continues to apply.',
      'Neither party may assign this agreement without the other’s written consent, except to a successor to substantially all of its business.',
      input.contactEmail ? `Notices under this agreement may be sent to ${input.contactEmail}.` : 'Notices under this agreement must be given in writing.',
    ],
  });

  return sections;
}

export function renderNdaText(nda: Omit<GeneratedNda, 'version'>): string {
  const lines: string[] = [nda.title, '', `Effective: ${nda.effectiveDate}`, ''];
  for (const section of nda.sections) {
    lines.push(section.heading, '');
    for (const paragraph of section.paragraphs) lines.push(paragraph, '');
  }
  lines.push(
    '',
    'Agreed by:',
    '',
    'Discloser: ______________________________   Date: ____________',
    '',
    'Recipient: ______________________________   Date: ____________',
  );
  return lines.join('\n').trim();
}

export async function generateNda(input: NdaInput): Promise<GeneratedNda> {
  const draft = {
    title: `Non-disclosure agreement${input.disclosingParty ? ` — ${input.disclosingParty}` : ''}`,
    effectiveDate: input.effectiveDate,
    sections: buildSections(input),
  };

  const digest = await sha256(utf8(renderNdaText(draft)));
  return { ...draft, version: toHex(digest).slice(0, 12) };
}

/**
 * Problems worth surfacing before the document is sent to anyone. Returned as
 * warnings rather than hard errors: these are judgement calls, and the operator
 * may have a reason. Refusing outright would be presumptuous; staying silent
 * would not.
 */
export function reviewNda(input: NdaInput): string[] {
  const warnings: string[] = [];

  if (!input.disclosingParty.trim()) {
    warnings.push('No disclosing party named. The agreement needs a counterparty to bind.');
  }
  if (!input.purpose.trim()) {
    warnings.push('No purpose stated. Without one, the limit on what the recipient may do with the information is unclear.');
  }
  if (looksLikeUsJurisdiction(input.jurisdiction) && !input.includeDtsaNotice) {
    warnings.push(
      'Governing law looks like a US jurisdiction but the Defend Trade Secrets Act immunity notice is off. Omitting it forfeits exemplary damages and attorney’s fees against this person under 18 U.S.C. § 1836(b)(3), which are usually the remedies worth having.',
    );
  }
  if (!looksLikeUsJurisdiction(input.jurisdiction) && input.includeDtsaNotice) {
    warnings.push(
      'The Defend Trade Secrets Act notice is on, but the governing law does not look like a US jurisdiction. It is harmless, but it will read as boilerplate copied from elsewhere.',
    );
  }
  if (input.termYears < 2) {
    warnings.push('A confidentiality term under two years is short for technical information, which tends to stay valuable longer than that.');
  }
  if (input.termYears > 10 && !input.perpetualForTradeSecrets) {
    warnings.push('A very long fixed term is sometimes read as unreasonable. Protecting trade secrets perpetually and setting a shorter fixed term for everything else is the more usual structure.');
  }
  if (!input.perpetualForTradeSecrets) {
    warnings.push(
      'Trade secret protection is set to expire with the fixed term. Trade secrets are protected for as long as they stay secret, so a fixed cut-off gives away more than it needs to.',
    );
  }

  return warnings;
}
