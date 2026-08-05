/**
 * Evidence capture.
 *
 * Writes go to Supabase over PostgREST from `ctx.waitUntil`, so logging never
 * sits in the response path. If the write fails the request has already been
 * served — we log the failure and move on; a dropped analytics row must never
 * become a customer-visible error.
 *
 * Blocked and challenged requests are always recorded. Allowed requests are
 * sampled, because the interesting artefact is the pattern of refusals.
 */

import type { DecisionAction, DecisionLayer, DecisionReason, EdgeProjectConfig } from '@foundershield/shared';
import type { RequestContext } from './context.js';
import type { Env } from './env.js';

export interface EventDraft {
  /** What the policy decided. */
  action: DecisionAction;
  /**
   * Whether that decision was actually applied. False for every non-allow
   * decision in `monitor` mode — the distinction between "we would have blocked
   * this" and "we blocked this" matters both operationally and evidentially.
   */
  enforced: boolean;
  reasons: DecisionReason[];
  botScore: number;
  sessionId: string | null;
  responseStatus: number;
  originMs: number | null;
  responseBytes: number | null;
  ipHash: string;
  /** Environment attestation returned by the challenge, when this was a verify call. */
  signals?: unknown;
}

function primaryLayer(reasons: readonly DecisionReason[]): DecisionLayer | null {
  const rank: Record<DecisionAction, number> = { allow: 0, challenge: 1, block: 2 };
  let best: DecisionReason | null = null;
  for (const reason of reasons) {
    if (reason.action === 'allow') continue;
    if (!best || rank[reason.action] > rank[best.action]) best = reason;
  }
  return best?.layer ?? null;
}

function shouldRecord(config: EdgeProjectConfig, action: DecisionAction, nowMs: number): boolean {
  if (action !== 'allow') return true;
  if (!config.logging.logAllowed) return false;
  if (config.logging.sampleRate >= 1) return true;
  if (config.logging.sampleRate <= 0) return false;
  // Deterministic-ish sampling without consuming entropy per request.
  return (nowMs % 1000) / 1000 < config.logging.sampleRate;
}

export function buildEventRow(
  context: RequestContext,
  config: EdgeProjectConfig,
  draft: EventDraft,
  nowMs: number,
): Record<string, unknown> {
  return {
    project_id: config.projectId,
    occurred_at: new Date(context.startedAt).toISOString(),
    ip: context.ip,
    ip_hash: draft.ipHash,
    method: context.method,
    host: context.host,
    path: context.path,
    query: context.url.search ? context.url.search.slice(1) : null,
    user_agent: context.userAgent,
    referer: context.referer,
    country: context.country,
    asn: context.asn,
    as_organisation: context.asOrganisation,
    tls_version: context.tlsVersion,
    edge_location: context.edgeLocation,
    request_id: context.requestId,
    action: draft.action,
    enforced: draft.enforced,
    primary_layer: primaryLayer(draft.reasons),
    reasons: draft.reasons,
    bot_score: draft.botScore,
    session_id: draft.sessionId,
    response_status: draft.responseStatus,
    decision_ms: Math.max(0, nowMs - context.startedAt),
    origin_ms: draft.originMs,
    response_bytes: draft.responseBytes,
    client_signals: draft.signals ?? null,
  };
}

export function recordEvent(
  env: Env,
  ctx: ExecutionContext,
  context: RequestContext,
  config: EdgeProjectConfig,
  draft: EventDraft,
): void {
  const nowMs = Date.now();
  if (!shouldRecord(config, draft.action, nowMs)) return;

  const row = buildEventRow(context, config, draft, nowMs);

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    // Local dev / fallback config: the log is still observable via `wrangler tail`.
    console.log('fs.event', JSON.stringify(row));
    return;
  }

  ctx.waitUntil(
    fetch(`${env.SUPABASE_URL}/rest/v1/request_events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    })
      .then(async (response) => {
        if (!response.ok) {
          console.error('evidence write rejected', response.status, await response.text().catch(() => ''));
        }
      })
      .catch((error) => console.error('evidence write failed', error)),
  );
}
