'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  normaliseConfig,
  defaultSettings,
  generateTerms,
  canAddDomain,
  getPlan,
  type TermsInput,
} from '@foundershield/shared';
import { currentPlanId } from './billing';
import { createSupabaseServerClient, createSupabaseServiceClient, requireUser } from './supabase/server';
import { checkProxyReachable, lookupTxt, purgeEdgeConfig } from './edge';
import { PROJECT_COLUMNS, type Project } from './types';

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function parseDomain(raw: FormDataEntryValue | null): string | null {
  if (typeof raw !== 'string') return null;
  const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

function parseOrigin(raw: FormDataEntryValue | null): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
  } catch {
    return null;
  }
}

/**
 * Confirms the signed-in user owns this project *before* any service-role work
 * happens. Every action that escalates goes through here first.
 */
async function assertOwnership(projectId: string): Promise<Project> {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const { data, error } = await supabase
    .from('projects')
    .select(PROJECT_COLUMNS)
    .eq('id', projectId)
    .single();

  if (error || !data) throw new Error('Project not found');
  return data as Project;
}

export async function createProject(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const name = String(formData.get('name') ?? '').trim();
  const domain = parseDomain(formData.get('domain'));
  const originUrl = parseOrigin(formData.get('origin_url'));

  if (!name) return { ok: false, error: 'Give the project a name.' };
  if (!domain) return { ok: false, error: 'Enter a valid domain, for example app.example.com.' };

  // The domain limit is enforced here, where refusing is safe. Traffic limits
  // deliberately are not enforced anywhere — see packages/shared/src/plans.ts.
  const [planId, { count }] = await Promise.all([
    currentPlanId(),
    supabase.from('projects').select('id', { count: 'exact', head: true }),
  ]);

  if (!canAddDomain(planId, count ?? 0)) {
    const plan = getPlan(planId);
    return {
      ok: false,
      error: `The ${plan.name} plan covers ${plan.domains} domain${plan.domains === 1 ? '' : 's'}, and you are using ${count ?? 0}. Upgrade to add another.`,
    };
  }

  if (!originUrl) {
    return { ok: false, error: 'Enter the full origin URL your traffic should be forwarded to, including https://.' };
  }
  if (new URL(originUrl).hostname === domain) {
    return {
      ok: false,
      error:
        'The origin cannot be the same hostname as the protected domain — that would make the proxy forward to itself. Point the origin at your server directly (for example origin.example.com or your host-provided URL).',
    };
  }

  const { error } = await supabase
    .from('projects')
    .insert({ user_id: user.id, name, domain, origin_url: originUrl });

  if (error) {
    if (error.code === '23505') return { ok: false, error: `${domain} is already protected on FounderShield.` };
    return { ok: false, error: error.message };
  }

  revalidatePath('/dashboard');
  return { ok: true, message: `${domain} added. Configure DNS to finish setup.` };
}

export async function updateProject(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const projectId = String(formData.get('project_id') ?? '');
  const project = await assertOwnership(projectId);

  const name = String(formData.get('name') ?? '').trim();
  const originUrl = parseOrigin(formData.get('origin_url'));
  if (!name) return { ok: false, error: 'Give the project a name.' };
  if (!originUrl) return { ok: false, error: 'Enter a valid origin URL including https://.' };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('projects').update({ name, origin_url: originUrl }).eq('id', projectId);
  if (error) return { ok: false, error: error.message };

  await purgeEdgeConfig(project.domain);
  revalidatePath(`/dashboard/projects/${projectId}`);
  return { ok: true, message: 'Saved.' };
}

export async function deleteProject(formData: FormData): Promise<void> {
  const projectId = String(formData.get('project_id') ?? '');
  const project = await assertOwnership(projectId);

  const supabase = await createSupabaseServerClient();
  await supabase.from('projects').delete().eq('id', projectId);
  await purgeEdgeConfig(project.domain);

  revalidatePath('/dashboard');
  redirect('/dashboard');
}

// ---------------------------------------------------------------------------
// Protection settings
// ---------------------------------------------------------------------------

function numberField(formData: FormData, key: string, fallback: number): number {
  const value = Number(formData.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function boolField(formData: FormData, key: string): boolean {
  return formData.get(key) === 'on' || formData.get(key) === 'true';
}

function lines(formData: FormData, key: string): string[] {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function updateSettings(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const projectId = String(formData.get('project_id') ?? '');
  const project = await assertOwnership(projectId);
  const defaults = defaultSettings();

  const payload = {
    mode: String(formData.get('mode') ?? 'standard'),
    tpm: {
      enabled: boolField(formData, 'tpm_enabled'),
      epochSeconds: numberField(formData, 'tpm_epoch', defaults.tpm.epochSeconds),
      ttlSeconds: numberField(formData, 'tpm_ttl', defaults.tpm.ttlSeconds),
      difficulty: numberField(formData, 'tpm_difficulty', defaults.tpm.difficulty),
      bindIp: boolField(formData, 'tpm_bind_ip'),
      bindUserAgent: boolField(formData, 'tpm_bind_ua'),
      protectPaths: lines(formData, 'tpm_protect_paths'),
      exemptPaths: lines(formData, 'tpm_exempt_paths'),
    },
    rate_limit: {
      enabled: boolField(formData, 'rl_enabled'),
      requestsPerMinute: numberField(formData, 'rl_rpm', defaults.rateLimit.requestsPerMinute),
      burst: numberField(formData, 'rl_burst', defaults.rateLimit.burst),
      banSeconds: numberField(formData, 'rl_ban', defaults.rateLimit.banSeconds),
    },
    bots: {
      enabled: boolField(formData, 'bots_enabled'),
      blockScore: numberField(formData, 'bots_block', defaults.bots.blockScore),
      challengeScore: numberField(formData, 'bots_challenge', defaults.bots.challengeScore),
      allowVerifiedBots: boolField(formData, 'bots_allow_verified'),
      blockedUserAgents: lines(formData, 'bots_blocked_ua'),
      allowedUserAgents: lines(formData, 'bots_allowed_ua'),
    },
    clickwrap: {
      enabled: boolField(formData, 'cw_enabled'),
      version: String(formData.get('cw_version') ?? '1').trim() || '1',
      tosUrl: String(formData.get('cw_tos_url') ?? '/terms').trim() || '/terms',
      requiredPaths: lines(formData, 'cw_paths'),
    },
    logging: {
      sampleRate: numberField(formData, 'log_sample', defaults.logging.sampleRate),
      logAllowed: boolField(formData, 'log_allowed'),
    },
    ip_allowlist: lines(formData, 'ip_allowlist'),
    ip_blocklist: lines(formData, 'ip_blocklist'),
  };

  if (payload.bots.challengeScore > payload.bots.blockScore) {
    return { ok: false, error: 'The challenge threshold must be at or below the block threshold.' };
  }

  // Round-trip through the same normaliser the proxy uses, so anything the form
  // could produce that the edge would silently clamp is rejected here instead.
  const preview = normaliseConfig({
    projectId,
    domain: project.domain,
    originUrl: project.origin_url,
    tpmSecret: 'placeholder',
    ...payload,
    rateLimit: payload.rate_limit,
  });
  if (!preview) return { ok: false, error: 'Those settings are not valid.' };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('protection_settings').update(payload).eq('project_id', projectId);
  if (error) return { ok: false, error: error.message };

  await purgeEdgeConfig(project.domain);
  revalidatePath(`/dashboard/projects/${projectId}`);
  return { ok: true, message: 'Protection settings saved and pushed to the edge.' };
}

export async function updateProtectedRoutes(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const projectId = String(formData.get('project_id') ?? '');
  const project = await assertOwnership(projectId);

  const patterns = lines(formData, 'routes');
  const routes = patterns.map((line, index) => {
    // `pattern mode [label]`, whitespace-separated.
    const [pattern, mode = 'session', ...label] = line.split(/\s+/);
    return {
      id: `r${index + 1}`,
      pattern,
      mode: ['session', 'clickwrap', 'apikey', 'ip_allowlist', 'deny'].includes(mode) ? mode : 'session',
      label: label.join(' ') || undefined,
      enabled: true,
    };
  });

  const authGate = {
    enabled: boolField(formData, 'gate_enabled'),
    authCookieName: String(formData.get('gate_cookie') ?? 'session').trim() || 'session',
    loginPath: String(formData.get('gate_login') ?? '/login').trim() || '/login',
    routes,
  };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('protection_settings')
    .update({ auth_gate: authGate })
    .eq('project_id', projectId);
  if (error) return { ok: false, error: error.message };

  await purgeEdgeConfig(project.domain);
  revalidatePath(`/dashboard/projects/${projectId}/routes`);
  return { ok: true, message: `${routes.length} protected route${routes.length === 1 ? '' : 's'} saved.` };
}

// ---------------------------------------------------------------------------
// Generated terms
// ---------------------------------------------------------------------------

export async function updateTerms(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const projectId = String(formData.get('project_id') ?? '');
  const project = await assertOwnership(projectId);

  const enabled = boolField(formData, 'cw_enabled');
  const useGenerated = boolField(formData, 'use_generated');
  const presentation = String(formData.get('presentation') ?? 'interstitial');

  const supabase = await createSupabaseServerClient();
  const { data: existing } = await supabase
    .from('protection_settings')
    .select('clickwrap')
    .eq('project_id', projectId)
    .single();

  const current = (existing?.clickwrap ?? {}) as Record<string, unknown>;

  if (!useGenerated) {
    const { error } = await supabase
      .from('protection_settings')
      .update({
        clickwrap: {
          ...current,
          enabled,
          terms: null,
          presentation: presentation === 'modal' ? 'modal' : 'interstitial',
          serveRobotsTxt: false,
          tosUrl: String(formData.get('tos_url') ?? '/terms').trim() || '/terms',
        },
      })
      .eq('project_id', projectId);
    if (error) return { ok: false, error: error.message };

    await purgeEdgeConfig(project.domain);
    revalidatePath(`/dashboard/projects/${projectId}/terms`);
    return { ok: true, message: 'Saved. FounderShield will link to your own terms.' };
  }

  const terms: TermsInput = {
    siteName: String(formData.get('site_name') ?? '').trim(),
    domain: project.domain,
    operator: String(formData.get('operator') ?? '').trim(),
    contactEmail: String(formData.get('contact_email') ?? '').trim(),
    jurisdiction: String(formData.get('jurisdiction') ?? '').trim() || 'England and Wales',
    effectiveDate: String(formData.get('effective_date') ?? '').trim() || new Date().toISOString().slice(0, 10),
    permitAiTraining: boolField(formData, 'permit_ai'),
    permitSearchIndexing: boolField(formData, 'permit_indexing'),
    permittedAgents: lines(formData, 'permitted_agents'),
  };

  if (!terms.siteName) return { ok: false, error: 'Enter the name people know your site by.' };
  if (!terms.operator) {
    return { ok: false, error: 'Enter the legal entity that operates the site — the terms need a counterparty.' };
  }
  if (!terms.contactEmail) return { ok: false, error: 'Enter a contact address for questions about the terms.' };

  // The version *is* the content hash, so a clause change necessarily
  // re-asks everyone. That is the point, but the UI warns before it happens.
  const generated = await generateTerms(terms);

  const { error } = await supabase
    .from('protection_settings')
    .update({
      clickwrap: {
        ...current,
        enabled,
        version: generated.version,
        tosUrl: '/__fs/v1/terms',
        terms,
        presentation: presentation === 'modal' ? 'modal' : 'interstitial',
        serveRobotsTxt: boolField(formData, 'serve_robots'),
      },
    })
    .eq('project_id', projectId);

  if (error) return { ok: false, error: error.message };

  await purgeEdgeConfig(project.domain);
  revalidatePath(`/dashboard/projects/${projectId}/terms`);

  const previousVersion = typeof current.version === 'string' ? current.version : null;
  return {
    ok: true,
    message:
      previousVersion && previousVersion !== generated.version
        ? `Terms saved as version ${generated.version}. Because the wording changed, everyone who accepted version ${previousVersion} will be asked again.`
        : `Terms saved as version ${generated.version}.`,
  };
}

// ---------------------------------------------------------------------------
// Domain verification
// ---------------------------------------------------------------------------

/**
 * Verification is done with the service role because its whole purpose is to
 * record a fact the customer must not be able to assert about themselves. The
 * ownership check above still runs first against the user's own session.
 */
export async function verifyDomain(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const projectId = String(formData.get('project_id') ?? '');
  const project = await assertOwnership(projectId);

  const txt = await lookupTxt(`_foundershield.${project.domain}`);
  const expected = `fs-verify=${project.verification_token}`;
  const dnsOk = txt.found.some((record) => record.trim() === expected);

  const proxy = await checkProxyReachable(project.domain, project.id);

  const service = createSupabaseServiceClient();
  const now = new Date().toISOString();

  await service
    .from('projects')
    .update({
      dns_verified_at: dnsOk ? (project.dns_verified_at ?? now) : null,
      proxy_verified_at: proxy.ok ? now : null,
      // A domain only goes live once traffic demonstrably reaches the proxy.
      status: proxy.ok ? 'active' : 'pending',
    })
    .eq('id', projectId);

  revalidatePath(`/dashboard/projects/${projectId}`);

  if (!dnsOk) {
    return {
      ok: false,
      error: `No matching TXT record at _foundershield.${project.domain}. ${
        txt.found.length > 0 ? `Found instead: ${txt.found.join(', ')}` : 'Nothing was returned yet — DNS can take a few minutes.'
      }`,
    };
  }

  if (!proxy.ok) {
    return {
      ok: false,
      error:
        proxy.project && proxy.project !== project.id
          ? `${project.domain} reaches a FounderShield proxy, but it is serving a different project. Check for a duplicate DNS record.`
          : `Ownership confirmed, but traffic for ${project.domain} is not reaching the proxy yet${
              proxy.error ? ` (${proxy.error})` : ''
            }. Check the CNAME record and try again in a few minutes.`,
    };
  }

  return { ok: true, message: `${project.domain} is verified and protection is live.` };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export async function sealEvidence(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const projectId = String(formData.get('project_id') ?? '');
  await assertOwnership(projectId);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('seal_evidence', { p_project_id: projectId });

  if (error) {
    if (error.message.includes('no unsealed events')) {
      return { ok: false, error: 'There are no new events to seal.' };
    }
    return { ok: false, error: error.message };
  }

  const seal = data as { event_count: number; digest: string } | null;
  revalidatePath(`/dashboard/projects/${projectId}/evidence`);
  return {
    ok: true,
    message: `Sealed ${seal?.event_count ?? 0} events. Digest ${seal?.digest?.slice(0, 16) ?? ''}…`,
  };
}
