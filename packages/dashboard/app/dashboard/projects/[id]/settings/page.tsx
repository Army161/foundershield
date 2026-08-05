import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/server';
import { updateSettings } from '@/lib/actions';
import { ActionForm, Field, SubmitButton, TextArea, Toggle } from '@/components/form';
import type { ProtectionSettings } from '@/lib/types';

const MODES = [
  {
    value: 'monitor',
    title: 'Monitor',
    description:
      'Nothing is blocked. Every decision is recorded so you can see what enforcement would do. Start here for a day or two on a live site.',
  },
  {
    value: 'standard',
    title: 'Standard',
    description:
      'Pages load normally and carry the verification challenge. API calls, data endpoints and assets require a verified browser. This is the right setting for most sites.',
  },
  {
    value: 'strict',
    title: 'Strict',
    description:
      'Nothing is served until the browser is verified, including the first page load. Visitors see a brief interstitial. Strongest protection, most visible.',
  },
];

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  const { data } = await supabase.from('protection_settings').select('*').eq('project_id', id).single();
  if (!data) notFound();
  const settings = data as ProtectionSettings;

  return (
    <ActionForm action={updateSettings} className="space-y-6">
      <input type="hidden" name="project_id" value={id} />

      <section className="card">
        <h2 className="text-base font-semibold">Enforcement mode</h2>
        <div className="mt-4 space-y-3">
          {MODES.map((mode) => (
            <label key={mode.value} className="flex items-start gap-3 rounded-lg border border-line p-4">
              <input
                type="radio"
                name="mode"
                value={mode.value}
                defaultChecked={settings.mode === mode.value}
                className="mt-1 h-4 w-4 accent-ink"
              />
              <span>
                <span className="text-sm font-medium">{mode.title}</span>
                <span className="block text-sm text-ink-faint">{mode.description}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">Browser verification</h2>
        <p className="hint">
          A short computation every real browser performs invisibly, then a rolling signed token on each request. Raising
          the difficulty costs an honest visitor milliseconds and costs a scraper the same on every single request it
          makes.
        </p>

        <div className="mt-4 space-y-1">
          <Toggle name="tpm_enabled" label="Require browser verification" defaultChecked={settings.tpm.enabled} />
          <Toggle
            name="tpm_bind_ua"
            label="Bind tokens to the browser"
            hint="A token copied out of one browser into another stops working."
            defaultChecked={settings.tpm.bindUserAgent}
          />
          <Toggle
            name="tpm_bind_ip"
            label="Bind tokens to the IP address"
            hint="Stronger, but signs visitors out when they move between mobile and Wi-Fi. Off by default for that reason."
            defaultChecked={settings.tpm.bindIp}
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field
            name="tpm_difficulty"
            label="Difficulty"
            type="number"
            min={8}
            max={22}
            defaultValue={settings.tpm.difficulty}
            hint="8–22. 14 is roughly 50ms on a phone."
          />
          <Field
            name="tpm_ttl"
            label="Token lifetime (s)"
            type="number"
            min={60}
            max={86400}
            defaultValue={settings.tpm.ttlSeconds}
          />
          <Field
            name="tpm_epoch"
            label="Key rotation (s)"
            type="number"
            min={60}
            max={86400}
            defaultValue={settings.tpm.epochSeconds}
            hint="How often signing keys roll."
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextArea
            name="tpm_protect_paths"
            label="Always require verification"
            defaultValue={settings.tpm.protectPaths.join('\n')}
            placeholder={'/api/**\n/data/*.json'}
            hint="One pattern per line. * is one segment, ** is any depth."
          />
          <TextArea
            name="tpm_exempt_paths"
            label="Never require verification"
            defaultValue={settings.tpm.exemptPaths.join('\n')}
            placeholder={'/webhooks/**\n/.well-known/**'}
            hint="Put payment and OAuth callbacks here — they are not browsers."
          />
        </div>
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">Automation detection</h2>
        <p className="hint">
          Scores each request from its headers alone, before any JavaScript runs. Requests at or above the block
          threshold are refused; those above the challenge threshold must verify first.
        </p>

        <div className="mt-4 space-y-1">
          <Toggle name="bots_enabled" label="Score incoming requests" defaultChecked={settings.bots.enabled} />
          <Toggle
            name="bots_allow_verified"
            label="Always allow verified search crawlers"
            hint="Googlebot, Bingbot and friends, only when the network confirms the claim. Turning this off will cost you search traffic."
            defaultChecked={settings.bots.allowVerifiedBots}
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            name="bots_block"
            label="Block at score"
            type="number"
            min={1}
            max={100}
            defaultValue={settings.bots.blockScore}
          />
          <Field
            name="bots_challenge"
            label="Challenge at score"
            type="number"
            min={1}
            max={100}
            defaultValue={settings.bots.challengeScore}
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextArea
            name="bots_blocked_ua"
            label="Always block these user-agents"
            defaultValue={settings.bots.blockedUserAgents.join('\n')}
            hint="Case-insensitive substring, one per line."
          />
          <TextArea
            name="bots_allowed_ua"
            label="Always allow these user-agents"
            defaultValue={settings.bots.allowedUserAgents.join('\n')}
            hint="Your own uptime monitor goes here."
          />
        </div>
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">Rate limiting</h2>
        <div className="mt-4 space-y-1">
          <Toggle name="rl_enabled" label="Limit requests per client" defaultChecked={settings.rate_limit.enabled} />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field
            name="rl_rpm"
            label="Requests per minute"
            type="number"
            min={1}
            defaultValue={settings.rate_limit.requestsPerMinute}
          />
          <Field name="rl_burst" label="Burst allowance" type="number" min={0} defaultValue={settings.rate_limit.burst} />
          <Field
            name="rl_ban"
            label="Cool-off (s)"
            type="number"
            min={0}
            defaultValue={settings.rate_limit.banSeconds}
          />
        </div>
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">Terms acceptance</h2>
        <p className="hint">
          Shows a one-time &ldquo;I agree&rdquo; gate before content is served, and records the timestamp. Bump the
          version to require everyone to accept again.
        </p>
        <div className="mt-4 space-y-1">
          <Toggle name="cw_enabled" label="Require acceptance" defaultChecked={settings.clickwrap.enabled} />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field name="cw_version" label="Terms version" defaultValue={settings.clickwrap.version} />
          <Field name="cw_tos_url" label="Terms URL" defaultValue={settings.clickwrap.tosUrl} />
        </div>
        <div className="mt-4">
          <TextArea
            name="cw_paths"
            label="Apply to these paths"
            defaultValue={settings.clickwrap.requiredPaths.join('\n')}
            hint="Leave empty to apply to the whole site."
          />
        </div>
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">Access lists</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextArea
            name="ip_allowlist"
            label="Always allow these addresses"
            defaultValue={settings.ip_allowlist.join('\n')}
            placeholder={'203.0.113.0/24\n2001:db8::/32'}
            hint="One address or CIDR range per line."
          />
          <TextArea
            name="ip_blocklist"
            label="Always block these addresses"
            defaultValue={settings.ip_blocklist.join('\n')}
          />
        </div>
      </section>

      <section className="card">
        <h2 className="text-base font-semibold">Logging</h2>
        <p className="hint">
          Blocked and challenged requests are always recorded. This controls how much ordinary traffic is sampled
          alongside them for context.
        </p>
        <div className="mt-4 space-y-1">
          <Toggle name="log_allowed" label="Also sample allowed requests" defaultChecked={settings.logging.logAllowed} />
        </div>
        <div className="mt-4 sm:max-w-xs">
          <Field
            name="log_sample"
            label="Sample rate"
            type="number"
            min={0}
            max={1}
            step={0.01}
            defaultValue={settings.logging.sampleRate}
            hint="0 to 1. 0.02 keeps 2% of allowed traffic."
          />
        </div>
      </section>

      <SubmitButton>Save protection settings</SubmitButton>
    </ActionForm>
  );
}
