import type {
  AuthGateSettings,
  BotSettings,
  ClickwrapSettings,
  DecisionReason,
  LoggingSettings,
  ProtectionMode,
  ProjectStatus,
  RateLimitSettings,
  TpmSettings,
} from '@foundershield/shared';

/**
 * `tpm_secret` is intentionally absent — the anon role has no column grant for
 * it, so a query that selected it would fail rather than leak it.
 */
export interface Project {
  id: string;
  user_id: string;
  name: string;
  domain: string;
  origin_url: string;
  status: ProjectStatus;
  verification_token: string;
  dns_verified_at: string | null;
  proxy_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export const PROJECT_COLUMNS =
  'id,user_id,name,domain,origin_url,status,verification_token,dns_verified_at,proxy_verified_at,created_at,updated_at';

export interface ProtectionSettings {
  project_id: string;
  mode: ProtectionMode;
  tpm: TpmSettings;
  rate_limit: RateLimitSettings;
  bots: BotSettings;
  auth_gate: AuthGateSettings;
  clickwrap: ClickwrapSettings;
  logging: LoggingSettings;
  ip_allowlist: string[];
  ip_blocklist: string[];
  updated_at: string;
}

export interface RequestEvent {
  id: number;
  project_id: string;
  occurred_at: string;
  ip: string | null;
  ip_hash: string;
  method: string;
  host: string;
  path: string;
  query: string | null;
  user_agent: string;
  referer: string | null;
  country: string | null;
  as_organisation: string | null;
  edge_location: string | null;
  request_id: string | null;
  action: 'allow' | 'challenge' | 'block';
  enforced: boolean;
  primary_layer: string | null;
  reasons: DecisionReason[];
  bot_score: number;
  response_status: number;
  row_hash: string | null;
}

export interface ActorBurden {
  ip: string;
  ip_hash: string;
  country: string | null;
  as_organisation: string | null;
  requests: number;
  blocked: number;
  challenged: number;
  allowed: number;
  bytes_served: number;
  origin_ms_total: number;
  first_seen: string;
  last_seen: string;
  active_seconds: number;
  mean_requests_per_minute: number;
  peak_requests_per_minute: number;
  distinct_paths: number;
  user_agents: string[] | null;
  rule_ids: string[] | null;
}

export interface EvidenceReportHeader {
  project: {
    id: string;
    name: string;
    domain: string;
    originUrl: string;
    status: string;
    createdAt: string;
    dnsVerifiedAt: string | null;
    proxyVerifiedAt: string | null;
  };
  settingsNow: Record<string, unknown>;
  window: { since: string; until: string };
  totals: {
    events: number;
    blocked: number;
    challenged: number;
    enforced: number;
    actors: number;
    bytesServed: number;
    originMs: number;
  };
  seals: Array<{
    id: string;
    fromEvent: number;
    toEvent: number;
    eventCount: number;
    digest: string;
    sealedAt: string;
  }>;
}

export interface SealVerification {
  sealId: string;
  intact: boolean;
  expectedDigest: string;
  actualDigest: string | null;
  expectedCount: number;
  actualCount: number;
  alteredRows: number;
  sealedAt: string;
}

export interface ProjectStats {
  total: number;
  blocked: number;
  challenged: number;
  allowed: number;
  byLayer: Record<string, number>;
  topIps: Array<{ ip: string; n: number; last_seen: string }>;
  topAgents: Array<{ user_agent: string; n: number }>;
  timeline: Array<{ bucket: string; allowed: number; challenged: number; blocked: number }>;
}
