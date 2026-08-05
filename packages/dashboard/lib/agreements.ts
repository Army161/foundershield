'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  generateNda,
  renderNdaText,
  reviewNda,
  looksLikeUsJurisdiction,
  generateAccessDemand,
  generateCircumventionDemand,
  generateDmcaNotice,
  type DemandInput,
  type IncidentSummary,
  type NdaInput,
} from '@foundershield/shared';
import { createSupabaseServerClient, createSupabaseServiceClient, requireUser } from './supabase/server';
import type { ActionResult } from './actions';
import { PROJECT_COLUMNS, type ActorBurden, type Project } from './types';

function boolField(formData: FormData, key: string): boolean {
  return formData.get(key) === 'on' || formData.get(key) === 'true';
}

function lines(formData: FormData, key: string): string[] {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return [];
  return raw.split('\n').map((line) => line.trim()).filter(Boolean);
}

function text(formData: FormData, key: string, fallback = ''): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : fallback;
}

// ---------------------------------------------------------------------------
// Agreements
// ---------------------------------------------------------------------------

export async function createAgreement(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const jurisdiction = text(formData, 'jurisdiction', 'England and Wales') || 'England and Wales';
  const termYears = Number(formData.get('term_years'));

  const input: NdaInput = {
    disclosingParty: text(formData, 'disclosing_party'),
    disclosingAddress: text(formData, 'disclosing_address'),
    receivingParty: text(formData, 'receiving_party'),
    mutual: boolField(formData, 'mutual'),
    purpose: text(formData, 'purpose', 'a working relationship'),
    jurisdiction,
    effectiveDate: text(formData, 'effective_date') || new Date().toISOString().slice(0, 10),
    termYears: Number.isFinite(termYears) && termYears > 0 ? Math.min(50, termYears) : 3,
    perpetualForTradeSecrets: boolField(formData, 'perpetual_trade_secrets'),
    // Default the statutory notice on for US governing law rather than making
    // the founder know to ask for it.
    includeDtsaNotice: formData.has('dtsa_notice')
      ? boolField(formData, 'dtsa_notice')
      : looksLikeUsJurisdiction(jurisdiction),
    contactEmail: text(formData, 'contact_email'),
  };

  if (!input.disclosingParty) {
    return { ok: false, error: 'Enter the legal entity disclosing the information — the agreement needs a party.' };
  }

  const nda = await generateNda(input);
  const name = text(formData, 'name') || `NDA — ${input.disclosingParty}`;

  const { error } = await supabase.from('agreements').insert({
    user_id: user.id,
    kind: 'nda',
    name,
    version: nda.version,
    input,
    body: renderNdaText(nda),
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath('/dashboard/agreements');

  const warnings = reviewNda(input);
  return {
    ok: true,
    message:
      warnings.length > 0
        ? `Created version ${nda.version}. Worth a look before you send it: ${warnings.join(' ')}`
        : `Created version ${nda.version}.`,
  };
}

export async function issueSignatureRequest(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const agreementId = text(formData, 'agreement_id');
  const signerName = text(formData, 'signer_name');
  const signerEmail = text(formData, 'signer_email');

  if (!signerName || !signerEmail) return { ok: false, error: 'Enter the signer’s name and email.' };

  // RLS scopes this to agreements the caller owns.
  const { data: agreement } = await supabase
    .from('agreements')
    .select('id,version')
    .eq('id', agreementId)
    .single();

  if (!agreement) return { ok: false, error: 'Agreement not found.' };

  const { error } = await supabase.from('agreement_signatures').insert({
    agreement_id: agreementId,
    signer_name: signerName,
    signer_email: signerEmail,
    signed_version: (agreement as { version: string }).version,
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/agreements/${agreementId}`);
  return {
    ok: true,
    message: `Signing link created for ${signerName}. Copy it from the list below and send it yourself — FounderShield does not email on your behalf.`,
  };
}

/**
 * The signing link is not readable through the browser client (no column
 * grant), so it is fetched here with the service role after ownership has been
 * confirmed against the caller's own session.
 */
export async function revealSigningLink(signatureId: string): Promise<string | null> {
  const { supabase, user } = await requireUser();
  if (!user) return null;

  const { data: owned } = await supabase
    .from('agreement_signatures')
    .select('id')
    .eq('id', signatureId)
    .single();
  if (!owned) return null;

  const service = createSupabaseServiceClient();
  const { data } = await service
    .from('agreement_signatures')
    .select('access_token')
    .eq('id', signatureId)
    .single();

  const token = (data as { access_token: string } | null)?.access_token;
  if (!token) return null;

  const base = process.env.NEXT_PUBLIC_APP_URL ?? '';
  return `${base}/sign/${token}`;
}

export async function revokeSignatureRequest(formData: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const signatureId = text(formData, 'signature_id');
  const agreementId = text(formData, 'agreement_id');

  await supabase.from('agreement_signatures').update({ status: 'revoked' }).eq('id', signatureId);
  revalidatePath(`/dashboard/agreements/${agreementId}`);
}

export async function deleteAgreement(formData: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  await supabase.from('agreements').delete().eq('id', text(formData, 'agreement_id'));
  revalidatePath('/dashboard/agreements');
  redirect('/dashboard/agreements');
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

async function ownedProject(projectId: string): Promise<Project> {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const { data } = await supabase.from('projects').select(PROJECT_COLUMNS).eq('id', projectId).single();
  if (!data) throw new Error('Project not found');
  return data as Project;
}

function toIncident(actor: ActorBurden): IncidentSummary {
  return {
    ip: actor.ip,
    firstSeen: new Date(actor.first_seen).toISOString().replace('T', ' ').replace('Z', ' UTC'),
    lastSeen: new Date(actor.last_seen).toISOString().replace('T', ' ').replace('Z', ' UTC'),
    requests: actor.requests,
    blocked: actor.blocked,
    peakPerMinute: actor.peak_requests_per_minute,
    distinctPaths: actor.distinct_paths,
    bytesServed: actor.bytes_served,
    userAgents: actor.user_agents ?? [],
    ruleIds: actor.rule_ids ?? [],
    asOrganisation: actor.as_organisation,
    country: actor.country,
  };
}

export async function draftDemand(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const projectId = text(formData, 'project_id');
  const project = await ownedProject(projectId);
  const supabase = await createSupabaseServerClient();

  const kind = text(formData, 'kind') === 'circumvention' ? 'circumvention' : 'access';
  const days = Number(formData.get('days')) || 30;
  const selected = formData.getAll('actor').map(String);

  if (selected.length === 0) {
    return { ok: false, error: 'Select at least one address to write about.' };
  }

  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

  const { data: burdenRows } = await supabase.rpc('actor_burden', {
    p_project_id: projectId,
    p_since: since.toISOString(),
    p_until: until.toISOString(),
  });

  const actors = ((burdenRows ?? []) as ActorBurden[]).filter((actor) => selected.includes(actor.ip));
  if (actors.length === 0) {
    return { ok: false, error: 'Those addresses are no longer in the selected period.' };
  }

  const { data: settingsRow } = await supabase
    .from('protection_settings')
    .select('clickwrap,auth_gate')
    .eq('project_id', projectId)
    .single();

  const clickwrap = (settingsRow?.clickwrap ?? {}) as { enabled?: boolean; version?: string };
  const authGate = (settingsRow?.auth_gate ?? {}) as { enabled?: boolean };

  const input: DemandInput = {
    senderName: text(formData, 'sender_name'),
    senderEntity: text(formData, 'sender_entity'),
    senderEmail: text(formData, 'sender_email'),
    domain: project.domain,
    recipientDescription: text(formData, 'recipient'),
    incidents: actors.map(toIncident),
    termsInForce: Boolean(clickwrap.enabled),
    termsVersion: clickwrap.version,
    gatedRoutes: Boolean(authGate.enabled),
    periodFrom: since.toISOString().slice(0, 10),
    periodTo: until.toISOString().slice(0, 10),
  };

  const result = kind === 'circumvention' ? generateCircumventionDemand(input) : generateAccessDemand(input);

  if (!result.ok) {
    return { ok: false, error: `Not enough information yet: ${result.missing.join(' ')}` };
  }

  const { error } = await supabase.from('notices').insert({
    project_id: projectId,
    kind,
    addressee: result.document.addressee,
    subject: result.document.subject,
    body: result.document.body,
    cautions: result.cautions,
    context: { incidents: input.incidents, periodFrom: input.periodFrom, periodTo: input.periodTo },
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/projects/${projectId}/notices`);
  return { ok: true, message: 'Draft saved. Read the cautions before you do anything with it.' };
}

export async function draftDmca(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const projectId = text(formData, 'project_id');
  await ownedProject(projectId);
  const supabase = await createSupabaseServerClient();

  const result = generateDmcaNotice({
    signatoryName: text(formData, 'signatory_name'),
    signatoryTitle: text(formData, 'signatory_title'),
    signatoryEmail: text(formData, 'signatory_email'),
    signatoryPhone: text(formData, 'signatory_phone'),
    signatoryAddress: text(formData, 'signatory_address'),
    rightsHolder: text(formData, 'rights_holder'),
    workDescription: text(formData, 'work_description'),
    originalUrls: lines(formData, 'original_urls'),
    infringingUrls: lines(formData, 'infringing_urls'),
    serviceProvider: text(formData, 'service_provider'),
    goodFaithBelief: boolField(formData, 'good_faith'),
    accuracyStatement: boolField(formData, 'accuracy'),
    authorityStatement: boolField(formData, 'authority'),
  });

  if (!result.ok) {
    return {
      ok: false,
      error: `This notice is not complete, and an incomplete notice does not oblige the host to do anything. Still needed: ${result.missing.join(' ')}`,
    };
  }

  const { error } = await supabase.from('notices').insert({
    project_id: projectId,
    kind: 'dmca-512',
    addressee: result.document.addressee,
    subject: result.document.subject,
    body: result.document.body,
    cautions: result.cautions,
    context: {},
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/projects/${projectId}/notices`);
  return { ok: true, message: 'Draft saved. Read every caution before you send it.' };
}

export async function markNoticeSent(formData: FormData): Promise<void> {
  const projectId = text(formData, 'project_id');
  await ownedProject(projectId);

  const supabase = await createSupabaseServerClient();
  await supabase
    .from('notices')
    .update({ marked_sent_at: new Date().toISOString() })
    .eq('id', text(formData, 'notice_id'));

  revalidatePath(`/dashboard/projects/${projectId}/notices`);
}

export async function deleteNotice(formData: FormData): Promise<void> {
  const projectId = text(formData, 'project_id');
  await ownedProject(projectId);

  const supabase = await createSupabaseServerClient();
  await supabase.from('notices').delete().eq('id', text(formData, 'notice_id'));

  revalidatePath(`/dashboard/projects/${projectId}/notices`);
}
