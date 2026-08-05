/**
 * The evidence record.
 *
 * This is the single most legally load-bearing structure in the product, so it
 * is deliberately boring: flat, append-only, and self-describing. Two rules:
 *
 *  1. Every field is something the edge *observed*, never something it inferred
 *     about a person. `reasons` carries our interpretation, and it is clearly
 *     separated from the raw observation fields.
 *  2. Nothing here is written by the customer. A field the customer controls is
 *     not evidence.
 *
 * Raw IPs are recorded because an exhibit without them is useless, but they are
 * also hashed so analytics and public-facing views can use `ipHash` and never
 * touch the address itself.
 */

export type DecisionAction = 'allow' | 'challenge' | 'block';

export type DecisionLayer =
  | 'allowlist'
  | 'blocklist'
  | 'bots'
  | 'ratelimit'
  | 'tpm'
  | 'authgate'
  | 'clickwrap';

export interface DecisionReason {
  layer: DecisionLayer;
  /** Stable rule identifier, e.g. `ua.scrapy` or `tpm.bad_signature`. */
  ruleId: string;
  /** One sentence, plain English, safe to paste into an exhibit. */
  description: string;
  action: DecisionAction;
}

export interface EvidenceEvent {
  projectId: string;
  /** ISO-8601 with milliseconds. */
  occurredAt: string;

  // --- Observation -------------------------------------------------------
  ip: string;
  ipHash: string;
  method: string;
  host: string;
  path: string;
  query: string | null;
  userAgent: string;
  referer: string | null;
  country: string | null;
  asn: number | null;
  asOrganisation: string | null;
  tlsVersion: string | null;
  /** Cloudflare colo that served the request — proves where it was observed. */
  edgeLocation: string | null;
  /** Cloudflare Ray ID; the network's own independent request identifier. */
  requestId: string | null;

  // --- Interpretation ----------------------------------------------------
  action: DecisionAction;
  primaryLayer: DecisionLayer | null;
  reasons: DecisionReason[];
  botScore: number;
  /** Session id from a valid token, when one was presented. */
  sessionId: string | null;
  responseStatus: number;
  /** Edge processing time, excluding origin fetch. */
  decisionMs: number;
  /** Origin round-trip, when the request was proxied. */
  originMs: number | null;
  /** Bytes returned to the client — the server-load measure. */
  responseBytes: number | null;
}

/**
 * Pick the operative decision from a set of layer results.
 *
 * Severity wins over order: a single `block` beats any number of `challenge`s.
 * Within the same severity, the earliest layer wins, which keeps the reported
 * cause stable and matches the order an operator would reason about.
 */
export function resolveDecision(reasons: readonly DecisionReason[]): {
  action: DecisionAction;
  primary: DecisionReason | null;
} {
  let primary: DecisionReason | null = null;
  const rank: Record<DecisionAction, number> = { allow: 0, challenge: 1, block: 2 };

  for (const reason of reasons) {
    if (reason.action === 'allow') continue;
    if (!primary || rank[reason.action] > rank[primary.action]) {
      primary = reason;
    }
  }

  return { action: primary?.action ?? 'allow', primary };
}

/**
 * A human-readable narrative of why a request was stopped. Used in the
 * dashboard and in exported reports so the customer never has to read rule ids.
 */
export function describeEvent(event: Pick<EvidenceEvent, 'action' | 'reasons' | 'ip' | 'occurredAt'>): string {
  if (event.reasons.length === 0) {
    return `${event.occurredAt} — request from ${event.ip} was allowed.`;
  }
  const verb = event.action === 'block' ? 'was blocked' : event.action === 'challenge' ? 'was challenged' : 'was allowed';
  const causes = event.reasons.map((r) => r.description).join('; ');
  return `${event.occurredAt} — request from ${event.ip} ${verb}. Observed: ${causes}.`;
}
