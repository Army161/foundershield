/**
 * Terms-of-use generation.
 *
 * This produces a *template*, not legal advice, and the dashboard says so
 * prominently. What it does well is the part a founder cannot easily write from
 * a generic template off the internet: clauses that describe the access
 * controls this specific site actually enforces, worded so they line up with
 * what the proxy does and what the evidence log records.
 *
 * Two properties matter:
 *
 *   Deterministic — the same inputs always produce byte-identical output, so
 *   the version hash is stable and two servers agree without coordinating.
 *
 *   Version-by-content — the version *is* a hash of the rendered text. Editing
 *   any clause necessarily bumps the version, which invalidates every prior
 *   acceptance. You cannot silently change the terms someone agreed to, which
 *   is exactly the failure mode that gets clickwrap thrown out.
 */

import { sha256 } from './crypto';
import { toHex, utf8 } from './encoding';

export interface TermsInput {
  /** Public-facing name of the site, e.g. "Acme". */
  siteName: string;
  /** The protected hostname. */
  domain: string;
  /** Legal entity operating the site, e.g. "Acme Ltd". */
  operator: string;
  contactEmail: string;
  /** e.g. "England and Wales", "the State of Delaware". */
  jurisdiction: string;
  /** ISO date the terms take effect. */
  effectiveDate: string;
  /** Whether the operator permits use of the content for AI/ML training. */
  permitAiTraining: boolean;
  /** Whether ordinary search-engine indexing is permitted. */
  permitSearchIndexing: boolean;
  /** Named agents allowed to access automatically, e.g. ["Googlebot"]. */
  permittedAgents: string[];
}

export interface TermsSection {
  id: string;
  heading: string;
  paragraphs: string[];
}

export interface GeneratedTerms {
  /** Content hash. Changing any clause changes this. */
  version: string;
  effectiveDate: string;
  title: string;
  sections: TermsSection[];
}

export const DEFAULT_TERMS_INPUT: TermsInput = {
  siteName: '',
  domain: '',
  operator: '',
  contactEmail: '',
  jurisdiction: 'England and Wales',
  effectiveDate: new Date(0).toISOString().slice(0, 10),
  permitAiTraining: false,
  permitSearchIndexing: true,
  permittedAgents: ['Googlebot', 'Bingbot'],
};

function list(items: readonly string[]): string {
  const cleaned = items.map((item) => item.trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  if (cleaned.length === 1) return cleaned[0] as string;
  return `${cleaned.slice(0, -1).join(', ')} and ${cleaned[cleaned.length - 1]}`;
}

/**
 * Build the clause set. Deliberately written in plain English: terms that a
 * reader cannot understand are terms a court is less willing to enforce, and
 * the whole point of clickwrap is demonstrating that assent was meaningful.
 */
function buildSections(input: TermsInput): TermsSection[] {
  const site = input.siteName || input.domain;
  const operator = input.operator || site;
  const agents = list(input.permittedAgents);

  const sections: TermsSection[] = [];

  sections.push({
    id: 'acceptance',
    heading: 'Agreement to these terms',
    paragraphs: [
      `These terms are a binding agreement between you and ${operator} ("we", "us") covering your access to ${input.domain} and everything served from it (the "Site").`,
      'You are shown these terms and asked to agree to them before you are given access. If you do not agree, do not access the Site. Continuing to access the Site after being shown these terms means you accept them.',
      'If you are accessing the Site on behalf of an organisation, you confirm you are authorised to accept these terms for that organisation.',
    ],
  });

  sections.push({
    id: 'permitted-use',
    heading: 'What you may do',
    paragraphs: [
      'You may view, read and interact with the Site for your own personal or internal business purposes, using an ordinary web browser.',
      'You may link to the Site, quote short extracts with attribution, and share pages with others.',
      'Everything not expressly permitted here is reserved. This is a licence to use the Site, not a transfer of any rights in it.',
    ],
  });

  const automatedAccess: string[] = [
    'You may not access the Site by automated means. This includes scraping, crawling, spidering, harvesting, indexing, bulk downloading, or using any script, bot, agent, headless browser or automation framework to retrieve content.',
    'You may not use the Site to build, populate or update a dataset, index, cache, archive or derivative database, whether for your own use or for supply to anyone else.',
  ];

  if (input.permitSearchIndexing && agents) {
    automatedAccess.push(
      `We permit ${agents} to crawl the Site for the purpose of ordinary search indexing, provided the crawler identifies itself honestly and its identity is verifiable. This permission covers search indexing only. It does not extend to any other purpose, and it does not extend to any other operator.`,
    );
  } else if (!input.permitSearchIndexing) {
    automatedAccess.push(
      'We do not permit automated crawling of the Site for search indexing or for any other purpose. No general permission is granted to any crawler.',
    );
  }

  automatedAccess.push(
    'Any permission we give for automated access is limited to the stated purpose, is personal to the operator we give it to, and may be withdrawn at any time.',
  );

  sections.push({ id: 'automated-access', heading: 'Automated access', paragraphs: automatedAccess });

  sections.push({
    id: 'ai-training',
    heading: 'Use for artificial intelligence and machine learning',
    paragraphs: input.permitAiTraining
      ? [
          'We permit content from the Site to be used for training or fine-tuning machine learning models, provided access is obtained through permitted means and attribution is retained.',
          'This permission does not authorise you to bypass any access control on the Site in order to obtain that content.',
        ]
      : [
          'You may not use any content from the Site to train, fine-tune, evaluate, ground, or otherwise develop any machine learning model, large language model, or generative artificial intelligence system.',
          'You may not supply content from the Site to any third party for those purposes, and you may not use the Site to generate synthetic data derived from its content.',
          'This is an express reservation of rights and an express refusal of permission for text and data mining. It applies regardless of whether an exception for text and data mining would otherwise be available, and it is intended to operate as a reservation of rights for the purposes of any law that allows rights to be reserved in this way.',
          'We also publish this refusal in machine-readable form. A machine-readable signal and this clause say the same thing; neither is a substitute for the other, and reading only one of them is not a defence.',
        ],
  });

  sections.push({
    id: 'access-controls',
    heading: 'Access controls',
    paragraphs: [
      'Access to the Site is controlled. Before content is served, our systems verify that the request comes from a genuine browser session, and certain areas are restricted to people who have signed in or who are otherwise authorised.',
      'You may not circumvent, bypass, disable, interfere with, or attempt to defeat any of these controls. This includes solving, replaying, forging or sharing any access token; simulating a browser in order to obtain a token; rotating addresses or identities to evade limits; and using another person\'s credentials.',
      'You may not access any part of the Site that you are not authorised to access, and you may not use any authorised access for a purpose outside the scope of that authorisation.',
      'These controls exist to restrict access. Getting around them is not a technicality: it is the thing these terms specifically prohibit.',
    ],
  });

  sections.push({
    id: 'service-burden',
    heading: 'Load on our systems',
    paragraphs: [
      'You may not place an unreasonable load on the Site. You may not send requests at a volume or rate that degrades the Site for other users, consumes a disproportionate share of our capacity, or increases our operating costs.',
      'We publish and enforce rate limits. Requests beyond those limits are refused, and persistently exceeding them is a breach of these terms.',
    ],
  });

  sections.push({
    id: 'monitoring',
    heading: 'What we record',
    paragraphs: [
      'We record technical details of requests made to the Site, including the network address the request came from, the time it was made, what was requested, the user-agent string presented, and whether our access controls allowed or refused it.',
      'We keep these records to operate and secure the Site, to enforce these terms, and as evidence in the event of a dispute. Records of refused requests are retained for longer than ordinary traffic records.',
      `If you would like to know what we hold about you, or you believe we hold it wrongly, contact ${input.contactEmail || 'us'}.`,
    ],
  });

  sections.push({
    id: 'intellectual-property',
    heading: 'Ownership',
    paragraphs: [
      `The Site, and the text, images, data, design, code and structure within it, belong to ${operator} or to our licensors, and are protected by copyright, database and other rights.`,
      'Nothing in these terms transfers any of those rights to you.',
    ],
  });

  sections.push({
    id: 'remedies',
    heading: 'If you breach these terms',
    paragraphs: [
      'We may withdraw your access to the Site at any time, without notice, if we believe you have breached these terms.',
      'Breaching these terms may also cause us loss that money alone does not adequately address, and we may seek an injunction or other equitable relief in addition to any other remedy available to us.',
      'We do not waive any right by not enforcing it immediately.',
    ],
  });

  sections.push({
    id: 'changes',
    heading: 'Changes to these terms',
    paragraphs: [
      'We may change these terms. When we do, the changed terms are given a new version and you are asked to agree again before you are given further access.',
      'Your agreement is recorded against the specific version you were shown. Changing these terms does not change what you previously agreed to, and it does not apply retrospectively to access that already happened.',
    ],
  });

  sections.push({
    id: 'governing-law',
    heading: 'Governing law',
    paragraphs: [
      `These terms are governed by the law of ${input.jurisdiction}, and the courts of ${input.jurisdiction} have jurisdiction over any dispute arising from them.`,
      `Questions about these terms can be sent to ${input.contactEmail || 'the operator of this site'}.`,
    ],
  });

  return sections;
}

/** Deterministic plain-text rendering. This is what the version hashes. */
export function renderTermsText(terms: Omit<GeneratedTerms, 'version'>): string {
  const lines: string[] = [terms.title, '', `Effective: ${terms.effectiveDate}`, ''];
  for (const section of terms.sections) {
    lines.push(section.heading, '');
    for (const paragraph of section.paragraphs) lines.push(paragraph, '');
  }
  return lines.join('\n').trim();
}

export async function generateTerms(input: TermsInput): Promise<GeneratedTerms> {
  const draft = {
    title: `Terms of use — ${input.siteName || input.domain}`,
    effectiveDate: input.effectiveDate,
    sections: buildSections(input),
  };

  // Version is derived from the rendered text, so no clause can change without
  // the version changing with it.
  const digest = await sha256(utf8(renderTermsText(draft)));
  return { ...draft, version: toHex(digest).slice(0, 12) };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderTermsHtml(terms: GeneratedTerms): string {
  const body = terms.sections
    .map(
      (section) =>
        `<section id="${escapeHtml(section.id)}"><h2>${escapeHtml(section.heading)}</h2>${section.paragraphs
          .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
          .join('')}</section>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(terms.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 44rem; padding: 48px 24px 96px;
         font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #fbfbfd; color: #16161d; }
  h1 { font-size: 1.6rem; letter-spacing: -0.01em; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 2.5rem 0 .5rem; }
  p { margin: 0 0 1rem; }
  .meta { color: #8a8a99; font-size: 14px; margin-bottom: 2rem; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d0d11; color: #f2f2f5; }
    .meta { color: #8a8a99; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(terms.title)}</h1>
<p class="meta">Version <code>${escapeHtml(terms.version)}</code> &middot; effective ${escapeHtml(terms.effectiveDate)}</p>
${body}
</body>
</html>`;
}

/**
 * The machine-readable counterpart to the AI-training clause, served at
 * `/.well-known/ai-permissions.json`. Stating the same refusal in both places
 * removes the "we only read robots.txt" and the "we only read the terms"
 * answers at the same time.
 */
export function aiPermissionsDocument(input: TermsInput, version: string): Record<string, unknown> {
  return {
    version: '1.0',
    site: input.domain,
    operator: input.operator || input.siteName || input.domain,
    contact: input.contactEmail || undefined,
    terms: `https://${input.domain}/__fs/v1/terms`,
    termsVersion: version,
    updated: input.effectiveDate,
    policies: {
      'ai-training': input.permitAiTraining ? 'allow' : 'deny',
      'ai-inference': input.permitAiTraining ? 'allow' : 'deny',
      'text-and-data-mining': input.permitAiTraining ? 'allow' : 'deny',
      'search-indexing': input.permitSearchIndexing ? 'allow' : 'deny',
    },
    reservationOfRights: !input.permitAiTraining,
    notice: input.permitAiTraining
      ? 'Use for machine learning is permitted subject to the terms of use.'
      : 'All rights are expressly reserved. Use of this content for training, fine-tuning or evaluating machine learning models is refused.',
  };
}

/** `robots.txt` reflecting the same policy, so all three sources agree. */
export function robotsTxt(input: TermsInput): string {
  const lines: string[] = [
    `# Terms of use: https://${input.domain}/__fs/v1/terms`,
    `# Machine-readable policy: https://${input.domain}/.well-known/ai-permissions.json`,
    '',
  ];

  const aiAgents = [
    'GPTBot',
    'ClaudeBot',
    'anthropic-ai',
    'CCBot',
    'Google-Extended',
    'PerplexityBot',
    'Bytespider',
    'Amazonbot',
    'Applebot-Extended',
    'meta-externalagent',
    'cohere-ai',
    'Diffbot',
    'omgili',
    'ImagesiftBot',
    'Timpibot',
    'YouBot',
  ];

  if (!input.permitAiTraining) {
    for (const agent of aiAgents) lines.push(`User-agent: ${agent}`, 'Disallow: /', '');
  }

  if (input.permitSearchIndexing) {
    for (const agent of input.permittedAgents.map((a) => a.trim()).filter(Boolean)) {
      lines.push(`User-agent: ${agent}`, 'Allow: /', '');
    }
    lines.push('User-agent: *', 'Disallow: /', '');
  } else {
    lines.push('User-agent: *', 'Disallow: /', '');
  }

  return lines.join('\n').trim() + '\n';
}
