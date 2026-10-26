// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings (05 §2). M3: Email and Emergency; M7: Recording; M11: Network (public IP watch), Security (phone ACL, provisioning, SIP TLS), Backups,
// Webhooks, API tokens; AI (spec 10).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import {
  WEBHOOK_EVENTS,
  formatNumber,
  type AiTestResult,
  LDAP_PRESETS,
  type AuthMode,
  type LdapInput,
  type OidcInput,
  type SettingsDto,
  type WebhookDto,
  type WebhookEvent,
} from '@selfphoneng/shared';
import {
  aiApi,
  apiTokensApi,
  contactsApi,
  didsApi,
  extensionsApi,
  settingsApi,
  systemApi,
  webhooksApi,
} from '../../api/client.ts';
import { ConfirmDialog } from '../../components/Dialog.tsx';
import { SoundPicker } from '../../components/SoundPicker.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

const TABS = [
  { id: 'email', label: 'Email' },
  { id: 'emergency', label: 'Emergency' },
  { id: 'recording', label: 'Recording' },
  { id: 'numbering', label: 'Numbering' },
  { id: 'network', label: 'Network' },
  { id: 'security', label: 'Security' },
  { id: 'backups', label: 'Backups' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'tokens', label: 'API tokens' },
  { id: 'ai', label: 'AI' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'sign-in', label: 'Sign-in' },
] as const;

export function SettingsPage() {
  const { tab = 'email' } = useParams();
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <nav
        aria-label="Settings"
        className="flex flex-wrap gap-1 border-b border-zinc-200 dark:border-zinc-800"
      >
        {TABS.map((t) => (
          <NavLink
            key={t.id}
            to={`/admin/settings/${t.id}`}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-1.5 text-sm font-medium ${isActive || (t.id === 'email' && tab === 'email') ? 'border-sky-600' : 'border-transparent hover:border-zinc-300'}`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      {settings.isError && <Alert>{settings.error.message}</Alert>}
      {settings.data && tab === 'email' && <EmailTab s={settings.data} />}
      {settings.data && tab === 'emergency' && <EmergencyTab s={settings.data} />}
      {settings.data && tab === 'recording' && <RecordingTab s={settings.data} />}
      {settings.data && tab === 'numbering' && <NumberingTab s={settings.data} />}
      {settings.data && tab === 'network' && <NetworkTab s={settings.data} />}
      {settings.data && tab === 'security' && <SecurityTab s={settings.data} />}
      {settings.data && tab === 'backups' && <BackupsTab s={settings.data} />}
      {settings.data && tab === 'webhooks' && <WebhooksTab s={settings.data} />}
      {tab === 'tokens' && <TokensTab />}
      {settings.data && tab === 'ai' && <AiTab s={settings.data} />}
      {settings.data && tab === 'contacts' && <ContactsTab s={settings.data} />}
      {settings.data && tab === 'sign-in' && (
        <div className="flex flex-col gap-10">
          <SignInTab s={settings.data} />
          <DirectoryForm s={settings.data} />
        </div>
      )}
    </section>
  );
}

function useSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: settingsApi.patch,
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
      void qc.invalidateQueries({ queryKey: ['warnings'] });
    },
  });
}

export function EmailTab({ s }: { s: SettingsDto }) {
  const save = useSave();
  const [v, setV] = useState({
    host: s.smtp?.host ?? '',
    port: String(s.smtp?.port ?? 587),
    secure: s.smtp?.secure ?? false,
    username: s.smtp?.username ?? '',
    password: '',
    from: s.smtp?.from ?? '',
  });
  const [to, setTo] = useState('');
  const test = useMutation({ mutationFn: () => settingsApi.testEmail(to) });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          smtp: v.host ? { ...v, port: Number(v.port), password: v.password || undefined } : null,
        });
      }}
    >
      <p className="text-sm text-zinc-500">
        The mail server used for emergency alerts and voicemail emails. Leave the server empty to
        turn email off.
      </p>
      {save.isError && <Alert>{save.error.message}</Alert>}
      {save.isSuccess && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Saved.
        </p>
      )}
      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <Field label="SMTP server">
          {(a) => (
            <input
              {...a}
              value={v.host}
              onChange={set('host')}
              placeholder="smtp.example.com"
              className={inputClass}
            />
          )}
        </Field>
        <Field label="Port">
          {(a) => (
            <input
              {...a}
              value={v.port}
              onChange={set('port')}
              inputMode="numeric"
              className={inputClass}
            />
          )}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={v.secure}
          onChange={(e) =>
            setV({ ...v, secure: e.target.checked, port: e.target.checked ? '465' : '587' })
          }
          className="size-4"
        />
        TLS from the start (port 465). Off: STARTTLS (port 587).
      </label>
      <Field label="Username">
        {(a) => (
          <input
            {...a}
            value={v.username}
            onChange={set('username')}
            autoComplete="off"
            className={inputClass}
          />
        )}
      </Field>
      <Field
        label="Password"
        hint={s.smtp?.hasPassword ? 'Leave empty to keep the current password.' : undefined}
      >
        {(a) => (
          <input
            {...a}
            type="password"
            value={v.password}
            onChange={set('password')}
            autoComplete="new-password"
            className={inputClass}
          />
        )}
      </Field>
      <Field label="From" hint="For example: Phone system <pbx@example.com>">
        {(a) => <input {...a} value={v.from} onChange={set('from')} className={inputClass} />}
      </Field>
      <div>
        <Button variant="primary" type="submit" disabled={save.isPending}>
          Save
        </Button>
      </div>

      {s.smtp && (
        <div className="flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <div className="flex items-end gap-2">
            <Field label="Send a test email to">
              {(a) => (
                <input
                  {...a}
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className={inputClass}
                />
              )}
            </Field>
            <Button onClick={() => test.mutate()} disabled={!to || test.isPending}>
              {test.isPending ? 'Sending…' : 'Send test'}
            </Button>
          </div>
          {test.isError && <Alert>{test.error.message}</Alert>}
          {test.isSuccess && (
            <p role="status" className="text-sm text-green-700 dark:text-green-400">
              Sent. Check the inbox (and the spam folder).
            </p>
          )}
        </div>
      )}
    </form>
  );
}

export function EmergencyTab({ s }: { s: SettingsDto }) {
  const save = useSave();
  const dids = useQuery({ queryKey: ['dids'], queryFn: didsApi.list });
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const [cid, setCid] = useState(s['emergency.defaultCallerIdDidId'] ?? '');
  const [emails, setEmails] = useState(s['emergency.notifyEmails'].join(', '));
  const [notify, setNotify] = useState<string[]>(s['emergency.notifyExtensionIds']);
  const test = useMutation({ mutationFn: settingsApi.testEmergency });

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          'emergency.defaultCallerIdDidId': cid || null,
          'emergency.notifyEmails': emails
            .split(/[,\s]+/)
            .map((x) => x.trim())
            .filter(Boolean),
          'emergency.notifyExtensionIds': notify,
        });
      }}
    >
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
        <p>
          Every phone can always dial <strong>911</strong> (and 9911), whatever its calling
          permission. Emergency services get the street address registered for the caller ID number{' '}
          <strong>at voip.ms</strong> (DID → e911), not anything typed here. Register an address for
          every number used as an emergency caller ID. People working elsewhere need their own
          number with their own address, or should call 911 from a mobile phone.
        </p>
        <p className="mt-2">
          US law (Kari&apos;s Law, RAY BAUM&apos;S Act) also asks that someone is notified when 911
          is dialed. This is a summary, not legal advice: check with counsel.
        </p>
      </div>
      {save.isError && <Alert>{save.error.message}</Alert>}
      {save.isSuccess && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Saved.
        </p>
      )}
      <Field
        label="Default emergency caller ID"
        hint="Used when an extension has no emergency caller ID of its own."
      >
        {(a) => (
          <select
            {...a}
            value={cid}
            onChange={(e) => setCid(e.target.value)}
            className={inputClass}
          >
            <option value="">Not set</option>
            {dids.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {formatNumber(d.number)}
                {d.label ? ` (${d.label})` : ''}
                {d.e911Address ? '' : ' — E911 address not confirmed'}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Email these people" hint="Separate addresses with commas.">
        {(a) => (
          <input
            {...a}
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            placeholder="frontdesk@example.com"
            className={inputClass}
          />
        )}
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">Ring these phones</legend>
        {exts.data?.length === 0 && <p className="text-sm text-zinc-500">No extensions yet.</p>}
        {exts.data?.map((x) => (
          <label key={x.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={notify.includes(x.id)}
              onChange={(e) =>
                setNotify(e.target.checked ? [...notify, x.id] : notify.filter((n) => n !== x.id))
              }
            />
            {x.number} {x.name}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" type="submit" disabled={save.isPending}>
          Save
        </Button>
        <Button onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? 'Testing…' : 'Test notifications'}
        </Button>
      </div>
      <p className="text-xs text-zinc-500">
        The test sends the email and rings the phones above with &quot;TEST&quot; in front. It never
        dials 911. Never test by calling 911.
      </p>
      {test.isError && <Alert>{test.error.message}</Alert>}
      {test.data && (
        <ul role="status" className="text-sm">
          {test.data.notified.length === 0 && (
            <li>Nobody to notify yet: add an email or a phone.</li>
          )}
          {test.data.notified.map((n) => (
            <li key={n.kind + n.to} className={n.ok ? '' : 'text-red-600 dark:text-red-400'}>
              {n.kind === 'email' ? 'Email to' : 'Rang'} {n.to}: {n.ok ? 'ok' : n.error}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/** Recording (08 §5): how long recordings are kept, and the notice callers hear first. */
function RecordingTab({ s }: { s: SettingsDto }) {
  const save = useSave();
  const [days, setDays] = useState(String(s['recordings.retentionDays']));
  const [vmDays, setVmDays] = useState(String(s['voicemail.retentionDays']));
  const [notice, setNotice] = useState<string | null>(s['recordings.announcementSoundId']);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          'recordings.retentionDays': Number(days),
          'voicemail.retentionDays': Number(vmDays),
          'recordings.announcementSoundId': notice,
        });
      }}
    >
      <div
        role="note"
        className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      >
        <p className="font-medium">Recording consent (not legal advice)</p>
        <p>
          US federal law and most states only need one party to agree, but several states (for
          example California, Florida, Illinois, Maryland, Massachusetts, Montana, New Hampshire,
          Pennsylvania and Washington) need everyone on the call to agree. Set a notice below so
          callers hear &ldquo;this call may be recorded&rdquo;, and check the law where you and your
          callers are.
        </p>
      </div>
      <SoundPicker
        label="Notice played before a recorded call"
        value={notice}
        onChange={setNotice}
        noneLabel="No notice"
      />
      <p className="-mt-2 text-xs text-zinc-500">
        Played to callers of phone numbers set to record (Phone numbers → Record every call).
      </p>
      <Field label="Keep recordings for (days)" hint="0 keeps them forever">
        {(p) => (
          <input
            {...p}
            className={`${inputClass} max-w-32`}
            inputMode="numeric"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        )}
      </Field>
      <Field label="Keep voicemail for (days)" hint="0 keeps it until the user deletes it">
        {(p) => (
          <input
            {...p}
            className={`${inputClass} max-w-32`}
            inputMode="numeric"
            value={vmDays}
            onChange={(e) => setVmDays(e.target.value)}
          />
        )}
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <span className="text-sm text-zinc-500">Saved.</span>}
      </div>
      {save.error && <Alert>{save.error.message}</Alert>}
    </form>
  );
}

/** The public IP Asterisk tells callers about, and re-checking it on a dynamic IP (01 §4.3, 04 §8). */
const RANGES = [
  ['numbering.users', 'Users (extensions)'],
  ['numbering.ringGroups', 'Ring groups'],
  ['numbering.queues', 'Queues'],
  ['numbering.ivrs', 'Digital receptionists'],
  ['numbering.conferences', 'Conference rooms'],
  ['numbering.paging', 'Paging groups'],
] as const;
type RangeKey = (typeof RANGES)[number][0];

/** Where "Next free" looks; any free number can still be typed in (owner, 2026-10-21). */
function NumberingTab({ s }: { s: SettingsDto }) {
  const save = useSave();
  const [v, setV] = useState(
    () =>
      Object.fromEntries(RANGES.map(([k]) => [k, s[k].map(String)])) as Record<RangeKey, string[]>,
  );
  const set = (k: RangeKey, i: 0 | 1, x: string) =>
    setV((o) => ({ ...o, [k]: i === 0 ? [x, o[k][1]] : [o[k][0], x] }));
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(Object.fromEntries(RANGES.map(([k]) => [k, v[k].map(Number)])));
      }}
    >
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Where <strong>Next free</strong> looks when you add a user, ring group, queue, digital
        receptionist, conference room or paging group. You can always type any other free number of
        1 to 6 digits instead, for example <strong>1</strong> for the first user: SelfPhoneNG checks
        that nothing else has it. Parking uses 700–720, and 911, 933 and the other N11 service codes
        can't be used.
      </p>
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-2 text-sm">
        <span />
        <span className="text-zinc-500">From</span>
        <span className="text-zinc-500">To</span>
        {RANGES.map(([k, label]) => (
          <Fragment key={k}>
            <span>{label}</span>
            {([0, 1] as const).map((i) => (
              <input
                key={i}
                aria-label={`${label} ${i === 0 ? 'from' : 'to'}`}
                type="number"
                min={0}
                max={999999}
                className={`${inputClass} w-28`}
                value={v[k][i]}
                onChange={(e) => set(k, i, e.target.value)}
              />
            ))}
          </Fragment>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <span className="text-sm text-zinc-500">Saved.</span>}
      </div>
      {save.error && <Alert>{save.error.message}</Alert>}
    </form>
  );
}

function NetworkTab({ s }: { s: SettingsDto }) {
  const save = useSave();
  const [ip, setIp] = useState(s['network.publicIp'] ?? '');
  const [watch, setWatch] = useState(s['network.publicIpWatch']);
  const [probe, setProbe] = useState(s['network.probeUrl'] ?? '');
  const detect = useMutation({ mutationFn: systemApi.detectPublicIp, onSuccess: setIp });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          'network.publicIp': ip.trim() || null,
          'network.publicIpWatch': watch,
          'network.probeUrl': probe.trim() || null,
        });
      }}
    >
      <Field label="Public IP" hint="Changing it needs a telephony restart (see System)">
        {(p) => (
          <div className="flex gap-2">
            <input
              {...p}
              className={`${inputClass} max-w-48`}
              value={ip}
              onChange={(e) => setIp(e.target.value)}
            />
            <Button type="button" onClick={() => detect.mutate()} disabled={detect.isPending}>
              Detect
            </Button>
          </div>
        )}
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={watch} onChange={(e) => setWatch(e.target.checked)} />
        Re-check the public IP every 5 minutes (dynamic IP)
      </label>
      <p className="-mt-2 text-xs text-zinc-500">
        When it changes, the new IP is saved and admins get an email asking for a telephony restart.
        Asks api.ipify.org (or ifconfig.me) for the address.
      </p>
      <Field
        label="Network test probe"
        hint="A probe running outside this network (apps/probe), for System → Diagnostics. It only ever tests the address that asks it. Empty: no tests from outside."
      >
        {(p) => (
          <input
            {...p}
            type="url"
            placeholder="https://probe.example.com"
            className={inputClass}
            value={probe}
            onChange={(e) => setProbe(e.target.value)}
          />
        )}
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <span className="text-sm text-zinc-500">Saved.</span>}
      </div>
      {(save.error ?? detect.error) && <Alert>{(save.error ?? detect.error)!.message}</Alert>}
    </form>
  );
}

const AI_KINDS = [
  {
    kind: 'llm',
    key: 'ai.llm',
    title: 'Language model',
    placeholder: 'http://127.0.0.1:11434/v1',
    hint: 'Ollama: http://127.0.0.1:11434/v1 and a model you pulled, for example qwen3:4b.',
  },
  {
    kind: 'stt',
    key: 'ai.stt',
    title: 'Speech to text',
    placeholder: 'http://127.0.0.1:8000/v1',
    hint: 'Speaches (deploy/ai): http://127.0.0.1:8000/v1 and a Whisper model, for example Systran/faster-whisper-small.',
  },
  {
    kind: 'tts',
    key: 'ai.tts',
    title: 'Text to speech',
    placeholder: 'http://127.0.0.1:8000/v1',
    hint: 'Speaches: http://127.0.0.1:8000/v1, speaches-ai/Kokoro-82M-v1.0-ONNX and a voice such as af_heart.',
  },
] as const;

/** Local AI (spec 10): three OpenAI-style endpoints, each with a test, and what uses them. */
function AiTab({ s }: { s: SettingsDto }) {
  const save = useSave();
  type Ep = { url: string; model: string; voice: string };
  const [eps, setEps] = useState(
    () =>
      Object.fromEntries(
        AI_KINDS.map(({ kind, key }) => [kind, { url: '', model: '', voice: '', ...s[key] }]),
      ) as Record<'llm' | 'stt' | 'tts', Ep>,
  );
  const [vmText, setVmText] = useState(s['ai.voicemailTranscripts']);
  const [callText, setCallText] = useState(s['ai.callTranscripts']);
  const [callSum, setCallSum] = useState(s['ai.callSummaries']);
  const [tests, setTests] = useState<Record<string, AiTestResult | 'running'>>({});
  const set = (kind: keyof typeof eps, k: keyof Ep, v: string) =>
    setEps((e) => ({ ...e, [kind]: { ...e[kind], [k]: v } }));
  const value = (kind: keyof typeof eps): Record<string, string> | null => {
    const { url, model, voice } = eps[kind];
    if (!url.trim()) return null;
    return kind === 'tts'
      ? { url: url.trim(), model: model.trim(), voice: voice.trim() }
      : { url: url.trim(), model: model.trim() };
  };
  const test = async (kind: 'llm' | 'stt' | 'tts') => {
    setTests((t) => ({ ...t, [kind]: 'running' }));
    const r = await aiApi
      .test(kind, value(kind) ?? {})
      .catch((err: Error) => ({ ok: false as const, error: err.message }));
    setTests((t) => ({ ...t, [kind]: r }));
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          'ai.llm': value('llm'),
          'ai.stt': value('stt'),
          'ai.tts': value('tts'),
          'ai.voicemailTranscripts': vmText,
          'ai.callTranscripts': callText,
          'ai.callSummaries': callText && callSum,
        });
      }}
    >
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        AI runs on this server or your local network only: an address must be localhost or a local
        IP (127.x, 10.x, 172.16–31.x, 192.168.x). Calls and text never go anywhere else. Leave an
        address empty to turn that part off.
      </p>
      {AI_KINDS.map(({ kind, title, hint, placeholder }) => {
        const t = tests[kind];
        return (
          <fieldset key={kind} className="flex flex-col gap-2">
            <legend className="mb-1 font-medium">{title}</legend>
            <p className="text-xs text-zinc-500">{hint}</p>
            <div className="flex flex-wrap gap-2">
              <input
                aria-label={`${title} address`}
                placeholder={placeholder}
                className={`${inputClass} max-w-72`}
                value={eps[kind].url}
                onChange={(e) => set(kind, 'url', e.target.value)}
              />
              <input
                aria-label={`${title} model`}
                placeholder="model"
                className={`${inputClass} max-w-72`}
                value={eps[kind].model}
                onChange={(e) => set(kind, 'model', e.target.value)}
              />
              {kind === 'tts' && (
                <input
                  aria-label={`${title} voice`}
                  placeholder="voice"
                  className={`${inputClass} max-w-40`}
                  value={eps[kind].voice}
                  onChange={(e) => set(kind, 'voice', e.target.value)}
                />
              )}
              <Button
                type="button"
                onClick={() => void test(kind)}
                disabled={t === 'running' || !eps[kind].url.trim()}
              >
                {t === 'running' ? 'Testing…' : 'Test'}
              </Button>
            </div>
            {t && t !== 'running' && (
              <p
                aria-label={`${title} test`}
                className={`text-sm ${t.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}
              >
                {t.ok ? `Works (${(t.ms / 1000).toFixed(1)} s): ${t.detail}` : t.error}
              </p>
            )}
            {t && t !== 'running' && t.ok && t.audio && (
              <audio controls src={t.audio} aria-label="Test voice" className="w-full max-w-sm" />
            )}
          </fieldset>
        );
      })}
      <h2 className="font-medium">What uses it</h2>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={vmText} onChange={(e) => setVmText(e.target.checked)} />
        Voicemail transcripts (speech to text)
      </label>
      <p className="-mt-2 text-xs text-zinc-500">
        New messages are written out before the voicemail email goes, and the text is in the email
        and on the voicemail page.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={callText} onChange={(e) => setCallText(e.target.checked)} />
        Call transcripts (speech to text)
      </label>
      <p className="-mt-2 text-xs text-zinc-500">
        Recorded calls are written out a minute or two after they end, the caller and the other side
        apart, and can be searched on the Recordings page. Only calls recorded while this is on.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={callText && callSum}
          disabled={!callText}
          onChange={(e) => setCallSum(e.target.checked)}
        />
        Call summaries and action items (language model)
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <span className="text-sm text-zinc-500">Saved.</span>}
      </div>
      {save.error && <Alert>{save.error.message}</Alert>}
    </form>
  );
}

/** Phone ACL (08 §2.2), outside calls at once (08 §1), provisioning access (07 §2), SIP port and TCP, SIP over TLS (M11-T2). */
function SecurityTab({ s }: { s: SettingsDto }) {
  const save = useSave();
  const cert = useQuery({ queryKey: ['tls'], queryFn: systemApi.tls });
  const [sipPort, setSipPort] = useState(String(s['sip.udpPort']));
  const [tcpOn, setTcpOn] = useState(s['sip.tcpEnabled']);
  const [tlsOn, setTlsOn] = useState(s['sip.tlsEnabled']);
  const [tlsPort, setTlsPort] = useState(String(s['sip.tlsPort']));
  const [restrict, setRestrict] = useState(s['sip.restrictPhonesToLocalNets']);
  const [extra, setExtra] = useState(s['sip.extraAllowedNets'].join(', '));
  const [lanOnly, setLanOnly] = useState(s['provisioning.lanOnly']);
  const [provOn, setProvOn] = useState(s['provisioning.enabled']);
  const [perExt, setPerExt] = useState(String(s['calls.maxPerExtension']));
  const [total, setTotal] = useState(String(s['calls.maxTotal']));
  const box = (checked: boolean, set: (v: boolean) => void, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          'sip.restrictPhonesToLocalNets': restrict,
          'sip.extraAllowedNets': extra.split(/[,\s]+/).filter(Boolean),
          'provisioning.lanOnly': lanOnly,
          'provisioning.enabled': provOn,
          'calls.maxPerExtension': Number(perExt),
          'calls.maxTotal': Number(total),
          'sip.udpPort': Number(sipPort),
          'sip.tcpEnabled': tcpOn,
          'sip.tlsEnabled': tlsOn,
          'sip.tlsPort': Number(tlsPort),
        });
      }}
    >
      <h2 className="font-medium">Desk phones</h2>
      {box(restrict, setRestrict, 'Only accept desk phones from the networks below')}
      <p className="-mt-2 text-xs text-zinc-500">
        Local networks: {s['network.localNets'].join(', ')}. Phones anywhere else (at home, on a
        mobile network) can't sign in while this is on. Browser phones still work from anywhere:
        they come through this website.
      </p>
      <Field
        label="Other networks allowed"
        hint="For example a branch office: 203.0.113.0/24. Separate with commas."
      >
        {(p) => (
          <input
            {...p}
            className={inputClass}
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
          />
        )}
      </Field>
      <h2 className="font-medium">Outside calls at once</h2>
      <p className="-mt-2 text-xs text-zinc-500">
        Limits the damage if someone steals a phone's password. Forwarded calls count for the person
        who set the forward. 911 is never limited. Callers over the limit hear "all circuits are
        busy". 0 = no limit.
      </p>
      <div className="flex flex-wrap gap-4">
        <Field label="Per extension">
          {(p) => (
            <input
              {...p}
              className={`${inputClass} max-w-32`}
              type="number"
              min={0}
              value={perExt}
              onChange={(e) => setPerExt(e.target.value)}
            />
          )}
        </Field>
        <Field label="For the whole system">
          {(p) => (
            <input
              {...p}
              className={`${inputClass} max-w-32`}
              type="number"
              min={0}
              value={total}
              onChange={(e) => setTotal(e.target.value)}
            />
          )}
        </Field>
      </div>
      <h2 className="font-medium">Phone setup files</h2>
      {box(provOn, setProvOn, 'Serve setup files to phones (Phones page)')}
      {box(lanOnly, setLanOnly, 'Only to phones on the local networks')}
      <h2 className="font-medium">SIP port</h2>
      <Field
        label="SIP port (UDP, and TCP below)"
        hint="5060 unless your router or ISP keeps UDP 5060 for itself: then for example 5080, forwarded on the router. Phones need setting up again (Phones page or the Linphone QR); trunks don't mind. Needs a telephony restart."
      >
        {(p) => (
          <input
            {...p}
            className={`${inputClass} max-w-32`}
            inputMode="numeric"
            value={sipPort}
            onChange={(e) => setSipPort(e.target.value)}
          />
        )}
      </Field>
      {box(tcpOn, setTcpOn, 'Accept SIP over TCP')}
      <p className="-mt-2 text-xs text-zinc-500">
        For phones and trunks set to TCP. Phones set up by this server use UDP.
      </p>
      <h2 className="font-medium">Encrypted SIP (TLS)</h2>
      <p className="text-sm" aria-label="TLS certificate">
        {cert.data?.ok
          ? `Certificate for ${cert.data.names.map((n) => n.replace(/^DNS:/, '')).join(', ') || cert.data.subject}, valid until ${new Date(cert.data.notAfter).toLocaleDateString()}.`
          : (cert.data?.error ?? '…')}
      </p>
      {box(tlsOn, setTlsOn, 'Accept SIP over TLS')}
      <p className="-mt-2 text-xs text-zinc-500">
        Needed for an encrypted voip.ms trunk. Turning it on or changing the port needs a telephony
        restart. After renewing the certificate, run scripts/tls-cert.sh.
      </p>
      <Field label="TLS port">
        {(p) => (
          <input
            {...p}
            className={`${inputClass} max-w-32`}
            inputMode="numeric"
            value={tlsPort}
            onChange={(e) => setTlsPort(e.target.value)}
          />
        )}
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <span className="text-sm text-zinc-500">Saved.</span>}
      </div>
      {save.error && <Alert>{save.error.message}</Alert>}
    </form>
  );
}

/** Backups (04 §8.1): schedule, list + download, Back up now. Restore is scripts/restore.sh. */
function BackupsTab({ s }: { s: SettingsDto }) {
  const save = useSave();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['backups'], queryFn: systemApi.backups });
  const now = useMutation({
    mutationFn: systemApi.backupNow,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['backups'] });
      void qc.invalidateQueries({ queryKey: ['warnings'] });
    },
  });
  const [enabled, setEnabled] = useState(s['backup.enabled']);
  const [time, setTime] = useState(s['backup.time']);
  const [keep, setKeep] = useState(String(s['backup.keep']));
  const [recs, setRecs] = useState(s['backup.includeRecordings']);
  const box = (checked: boolean, set: (v: boolean) => void, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            'backup.enabled': enabled,
            'backup.time': time,
            'backup.keep': Number(keep),
            'backup.includeRecordings': recs,
          });
        }}
      >
        {box(enabled, setEnabled, 'Back up every day')}
        <Field label="At" hint="In the PBX's time zone">
          {(p) => (
            <input
              {...p}
              type="time"
              className={`${inputClass} max-w-32`}
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          )}
        </Field>
        <Field label="Keep the newest">
          {(p) => (
            <input
              {...p}
              className={`${inputClass} max-w-32`}
              inputMode="numeric"
              value={keep}
              onChange={(e) => setKeep(e.target.value)}
            />
          )}
        </Field>
        {box(recs, setRecs, 'Include call recordings (they can be large)')}
        <p className="-mt-2 text-xs text-zinc-500">
          Backups hold the database, voicemail, sounds and music on hold, in data/backups on the
          server. Copy them somewhere else too. Passwords inside are encrypted with APP_SECRET from
          .env: keep a copy of .env, or a backup can't be restored. To restore, run
          scripts/restore.sh with the file.
        </p>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Save
          </Button>
          {save.isSuccess && <span className="text-sm text-zinc-500">Saved.</span>}
        </div>
        {save.error && <Alert>{save.error.message}</Alert>}
      </form>
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Backups on the server</h2>
          <Button onClick={() => now.mutate()} disabled={now.isPending}>
            {now.isPending ? 'Backing up…' : 'Back up now'}
          </Button>
        </div>
        {now.error && <Alert>{now.error.message}</Alert>}
        {list.data?.length === 0 && <p className="text-sm text-zinc-500">No backups yet.</p>}
        <ul aria-label="Backups" className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {list.data?.map((b) => (
            <li key={b.name} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                {new Date(b.createdAt).toLocaleString()}{' '}
                <span className="text-zinc-500">({(b.size / 1048576).toFixed(1)} MB)</span>
              </span>
              <a
                className="text-sky-700 hover:underline dark:text-sky-400"
                href={`/api/system/backups/${b.name}/download`}
                download
              >
                Download
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Webhooks (04 §9): where events are POSTed, signed with each webhook's secret. */
function WebhooksTab({ s }: { s: SettingsDto }) {
  const qc = useQueryClient();
  const save = useSave();
  const list = useQuery({ queryKey: ['webhooks'], queryFn: webhooksApi.list });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['webhooks'] });
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>(['call.ended']);
  const add = useMutation({
    mutationFn: () => webhooksApi.create({ url: url.trim(), events }),
    onSuccess: () => {
      setUrl('');
      refresh();
    },
  });
  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Send events to" hint="An https:// address that accepts a POST">
          {(p) => (
            <input
              {...p}
              className={inputClass}
              type="url"
              placeholder="https://example.com/selfphoneng"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </Field>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">Events</legend>
          {WEBHOOK_EVENTS.map((ev) => (
            <label key={ev} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={events.includes(ev)}
                onChange={(e) =>
                  setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))
                }
              />
              <code>{ev}</code>
            </label>
          ))}
        </fieldset>
        <div>
          <Button type="submit" variant="primary" disabled={add.isPending}>
            Add webhook
          </Button>
        </div>
        {add.error && <Alert>{add.error.message}</Alert>}
      </form>
      <ul aria-label="Webhooks" className="flex flex-col gap-3">
        {list.data?.map((w) => (
          <WebhookItem key={w.id} w={w} onChange={refresh} />
        ))}
      </ul>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={s['webhooks.allowPrivate']}
          onChange={(e) => save.mutate({ 'webhooks.allowPrivate': e.target.checked })}
        />
        Allow addresses on private networks (10.x, 192.168.x, localhost …)
      </label>
      <p className="-mt-4 text-xs text-zinc-500">
        Off by default, so a webhook can't reach services inside your network. Turn it on for a
        receiver in your own network (home lab).
      </p>
      {save.error && <Alert>{save.error.message}</Alert>}
      <p className="text-xs text-zinc-500">
        Each POST has the headers X-SelfPhoneNG-Event, X-SelfPhoneNG-Timestamp and
        X-SelfPhoneNG-Signature: sha256= the hex HMAC-SHA256 of timestamp + &quot;.&quot; + body
        with the webhook&apos;s secret. A failed POST is tried again after 1 and 5 minutes, half an
        hour, 2 and 12 hours.
      </p>
    </div>
  );
}

function WebhookItem({ w, onChange }: { w: WebhookDto; onChange: () => void }) {
  const [showLog, setShowLog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const log = useQuery({
    queryKey: ['webhook-deliveries', w.id],
    queryFn: () => webhooksApi.deliveries(w.id),
    enabled: showLog,
  });
  const test = useMutation({ mutationFn: () => webhooksApi.test(w.id) });
  const toggle = useMutation({
    mutationFn: () => webhooksApi.update(w.id, { enabled: !w.enabled }),
    onSuccess: onChange,
  });
  const remove = useMutation({ mutationFn: () => webhooksApi.remove(w.id), onSuccess: onChange });
  return (
    <li className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium break-all">{w.url}</span>
        <span className="text-zinc-500">{w.enabled ? 'On' : 'Off'}</span>
      </div>
      <p className="text-zinc-500">{w.events.join(', ')}</p>
      <p>
        Secret: <code className="break-all">{w.secret}</code>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => test.mutate()} disabled={test.isPending}>
          Send test
        </Button>
        <Button onClick={() => toggle.mutate()}>{w.enabled ? 'Turn off' : 'Turn on'}</Button>
        <Button onClick={() => setShowLog(!showLog)}>
          {showLog ? 'Hide deliveries' : 'Deliveries'}
        </Button>
        <Button variant="danger" onClick={() => setConfirm(true)}>
          Remove
        </Button>
      </div>
      {test.data && (
        <p role="status">
          {test.data.ok
            ? `Test sent: the server answered ${test.data.status}.`
            : `Test failed: ${test.data.error ?? `the server answered ${test.data.status}`}`}
        </p>
      )}
      {showLog && (
        <ul aria-label="Deliveries" className="text-xs text-zinc-600 dark:text-zinc-400">
          {log.data?.length === 0 && <li>Nothing sent yet.</li>}
          {log.data?.map((d) => (
            <li key={d.id}>
              {new Date(d.createdAt).toLocaleString()} <code>{d.event}</code> {d.status}
              {d.responseCode !== null && ` (${d.responseCode})`}
              {d.attempt > 1 && `, ${d.attempt} tries`}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirm}
        title="Remove webhook"
        message={<p>Stop sending events to {w.url}?</p>}
        confirmLabel="Remove"
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirm(false)}
        busy={remove.isPending}
        error={remove.error?.message}
      />
    </li>
  );
}

/** API tokens (04 §2.3): Bearer tokens for scripts, acting as the admin who made them. */
function TokensTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['api-tokens'], queryFn: apiTokensApi.list });
  const [name, setName] = useState('');
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);
  const create = useMutation({
    mutationFn: () => apiTokensApi.create(name.trim()),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['api-tokens'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => apiTokensApi.revoke(id),
    onSuccess: () => {
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: ['api-tokens'] });
    },
  });
  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Token name" hint="What uses it, like “CRM” or “backup script”">
          {(p) => (
            <input
              {...p}
              className={`${inputClass} max-w-sm`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <div>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Create token
          </Button>
        </div>
        {create.error && <Alert>{create.error.message}</Alert>}
        {create.data && (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          >
            <p className="font-medium">Copy the token now: it isn&apos;t shown again.</p>
            <code aria-label="New token" className="break-all">
              {create.data.token}
            </code>
          </div>
        )}
      </form>
      <p className="-mt-2 text-xs text-zinc-500">
        Send it as the header Authorization: Bearer &lt;token&gt;. A token can do everything its
        admin can, except manage tokens. It stops working when revoked or when the admin is
        disabled.
      </p>
      {list.data?.length === 0 && <p className="text-sm text-zinc-500">No tokens.</p>}
      <ul aria-label="API tokens" className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {list.data?.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>
              <span className="font-medium">{t.name}</span>{' '}
              <code className="text-zinc-500">{t.tokenPrefix}…</code>
              <span className="block text-xs text-zinc-500">
                By {t.createdBy}, last used{' '}
                {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'never'}
              </span>
            </span>
            <Button variant="danger" onClick={() => setRevoking(t)}>
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke token"
        message={<p>Anything using {revoking?.name} stops working right away.</p>}
        confirmLabel="Revoke"
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        onCancel={() => setRevoking(null)}
        busy={revoke.isPending}
        error={revoke.error?.message}
      />
    </div>
  );
}

/** Contacts (spec 11): the builtin books, or Contrack running beside the PBX. Also a setup step. */
export function ContactsTab({ s }: { s: SettingsDto }) {
  const save = useSave();
  const ctk = s['contacts.contrack'];
  const [provider, setProvider] = useState(s['contacts.provider']);
  const [v, setV] = useState({
    url: ctk?.url ?? 'http://127.0.0.1:3210',
    publicUrl: ctk?.publicUrl ?? '',
    companyToken: '',
  });
  const test = useMutation({
    mutationFn: () => contactsApi.testContrack(v.url, v.companyToken || undefined),
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          'contacts.provider': provider,
          ...(provider === 'contrack'
            ? {
                'contacts.contrack': {
                  url: v.url,
                  publicUrl: v.publicUrl,
                  companyToken: v.companyToken || undefined,
                },
              }
            : {}),
        });
        setV({ ...v, companyToken: '' });
      }}
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-medium">Where contacts live</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="provider"
            checked={provider === 'builtin'}
            onChange={() => setProvider('builtin')}
          />
          <span>
            <span className="font-medium">Simple</span>: a phonebook inside SelfPhoneNG. Names,
            numbers, .vcf and CSV import, sharing. Nothing else to run.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="provider"
            checked={provider === 'contrack'}
            onChange={() => setProvider('contrack')}
          />
          <span>
            <span className="font-medium">Contrack</span>: a full contact and relationship manager
            next to the phone system (notes, reminders, relationship tracking, imports from Google,
            Apple and LinkedIn, CardDAV sync). Each person has their own Contrack account, and the
            company has one everyone sees. It runs as its own container:{' '}
            <code>docker compose --env-file .env -f deploy/contrack/compose.yml up -d</code>.
          </span>
        </label>
      </fieldset>
      {provider === 'contrack' && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 font-medium">Contrack</legend>
          <Field
            label="Address the phone system uses"
            hint="On this server or the local network: localhost or a local IP"
          >
            {(a) => <input {...a} className={inputClass} value={v.url} onChange={set('url')} />}
          </Field>
          <Field
            label="Address people open"
            hint="Its own host name, such as https://contacts.example.com (CONTRACK_HOSTNAME in .env)"
          >
            {(a) => (
              <input
                {...a}
                className={inputClass}
                placeholder="https://contacts.example.com"
                value={v.publicUrl}
                onChange={set('publicUrl')}
              />
            )}
          </Field>
          <Field
            label="Company account token"
            hint={
              ctk?.hasCompanyToken
                ? 'Saved. Paste a new one to replace it.'
                : 'Make a Contrack account for the company (such as company@…), then in its Settings → Account → API tokens, create one that never expires.'
            }
          >
            {(a) => (
              <input
                {...a}
                type="password"
                autoComplete="off"
                placeholder={ctk?.hasCompanyToken ? '••••••••' : 'ctk_…'}
                className={inputClass}
                value={v.companyToken}
                onChange={set('companyToken')}
              />
            )}
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => test.mutate()} disabled={test.isPending}>
              Test
            </Button>
            {test.data && (
              <span
                role="status"
                className={`text-sm ${test.data.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}
              >
                {test.data.ok ? test.data.detail : test.data.error}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500">
            Each person then connects their own Contrack account in My settings, Contacts. If the AI
            inside Contrack uses a cloud provider, what is stored there reaches that provider: turn
            it off in Contrack, or point it at your local AI.
          </p>
        </fieldset>
      )}
      {save.isError && <Alert>{save.error.message}</Alert>}
      {save.isSuccess && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Saved.
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

const lines = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Sign-in (spec 12 §5): the mode, and the OpenID Connect provider. */
function SignInTab({ s }: { s: SettingsDto }) {
  const save = useSave();
  const o = s['auth.oidc'];
  const [mode, setMode] = useState<AuthMode>(s['auth.mode']);
  const [v, setV] = useState({
    label: o?.label ?? 'Keycloak',
    issuer: o?.issuer ?? '',
    clientId: o?.clientId ?? 'selfphoneng',
    clientSecret: '',
    scopes: o?.scopes ?? 'openid email profile',
    groupsClaim: o?.groupsClaim ?? 'groups',
    adminGroups: o?.adminGroups.join('\n') ?? '',
    allowedGroups: o?.allowedGroups.join('\n') ?? '',
    trustEmail: o?.trustEmail ?? false,
  });
  const input = (): OidcInput => ({
    ...v,
    clientSecret: v.clientSecret || undefined,
    adminGroups: lines(v.adminGroups),
    allowedGroups: lines(v.allowedGroups),
  });
  const test = useMutation({ mutationFn: () => settingsApi.testOidc(input()) });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });
  const host = window.location.host;
  const uris = [
    ['Redirect URI', `https://${host}/api/auth/oidc/callback`],
    ['Post-logout redirect URI', `https://${host}/login`],
  ] as const;
  const text = (k: keyof typeof v, label: string, hint?: string, placeholder?: string) => (
    <Field label={label} hint={hint}>
      {(a) => (
        <input
          {...a}
          className={inputClass}
          placeholder={placeholder}
          value={v[k] as string}
          onChange={set(k)}
        />
      )}
    </Field>
  );
  const area = (k: 'adminGroups' | 'allowedGroups', label: string, hint: string) => (
    <Field label={label} hint={hint}>
      {(a) => <textarea {...a} rows={2} className={inputClass} value={v[k]} onChange={set(k)} />}
    </Field>
  );
  const modes = [
    ['password', 'Passwords', 'Email and password, as set up here.'],
    [
      'mixed',
      'Passwords or OpenID',
      `Both. People connect their ${v.label} account in their settings. Disabling someone in ${v.label} ends their ${v.label} sign-ins, but their password keeps working until you disable them on Users.`,
    ],
    [
      'oidc',
      'OpenID only',
      `Only ${v.label} decides who gets in. Admins can still sign in with a password (Admin sign-in on the login page), for when ${v.label} is down.`,
    ],
  ] as const;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ 'auth.oidc': v.issuer.trim() ? input() : null, 'auth.mode': mode });
        setV({ ...v, clientSecret: '' });
      }}
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-medium">How people sign in</legend>
        {modes.map(([id, title, about]) => (
          <label key={id} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="auth-mode"
              checked={mode === id}
              onChange={() => setMode(id)}
            />
            <span>
              <span className="font-medium">{title}</span>: {about}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-medium">OpenID Connect</legend>
        <p className="text-sm text-zinc-500">
          Keycloak, Authentik, Authelia, Zitadel, Entra ID, Google and others. At the provider, make
          a confidential client using the standard (authorization code) flow, and add these:
        </p>
        <dl className="flex flex-col gap-2 text-sm">
          {uris.map(([label, uri]) => (
            <div key={label} className="flex flex-wrap items-center gap-2">
              <dt className="w-48 text-zinc-500">{label}</dt>
              <dd className="flex items-center gap-2">
                <code className="rounded bg-zinc-100 px-2 py-1 dark:bg-zinc-800">{uri}</code>
                <Button onClick={() => void navigator.clipboard?.writeText(uri)}>Copy</Button>
              </dd>
            </div>
          ))}
        </dl>
        {text('label', 'Button name', 'Shown as "Sign in with …"')}
        {text(
          'issuer',
          'Issuer',
          'Exactly as the provider writes it. Leave empty to turn OpenID Connect off.',
          'https://kc.example.com/realms/company',
        )}
        {text('clientId', 'Client ID')}
        <Field
          label="Client secret"
          hint={
            o?.hasClientSecret
              ? 'Saved. Type a new one to replace it.'
              : 'Empty for a public client (PKCE only)'
          }
        >
          {(a) => (
            <input
              {...a}
              type="password"
              autoComplete="off"
              placeholder={o?.hasClientSecret ? '••••••••' : ''}
              className={inputClass}
              value={v.clientSecret}
              onChange={set('clientSecret')}
            />
          )}
        </Field>
        {text(
          'scopes',
          'Scopes',
          'Add offline_access so people who keep the softphone open stay signed in past the provider’s session limit.',
        )}
        {text(
          'groupsClaim',
          'Groups claim',
          'Where the provider puts groups or roles: groups, roles, realm_access.roles, resource_access.<client>.roles …',
        )}
        {area(
          'adminGroups',
          'Admin groups',
          'One per line, exactly as sent (Keycloak with full group path: /pbx-admins). Members are admins, others users. Empty: you set roles on Users.',
        )}
        {area(
          'allowedGroups',
          'Allowed groups',
          'One per line. Empty: anyone with a connected account.',
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={v.trustEmail}
            onChange={(e) => setV({ ...v, trustEmail: e.target.checked })}
          />
          <span>
            Trust email addresses without “email verified”. Turn on only if people can’t change
            their own email at {v.label} (a single company’s Keycloak with email editing off, a
            single-tenant Entra ID). Only used to match people who have no password here.
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => test.mutate()} disabled={test.isPending || !v.issuer.trim()}>
            Test
          </Button>
          {test.data && (
            <span
              role="status"
              className={`text-sm ${test.data.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}
            >
              {test.data.ok
                ? `Works: ${test.data.issuer}. Signing: ${test.data.algorithms.join(', ') || '?'}. ${test.data.refreshTokens ? 'Refresh tokens' : 'No refresh tokens'}, ${test.data.endSession ? 'signs out there too' : 'no sign-out endpoint'}.`
                : test.data.error}
            </span>
          )}
          {test.error && <Alert>{test.error.message}</Alert>}
        </div>
        <p className="text-xs text-zinc-500">
          Then connect your own account in My account, and sign in from a private window.
        </p>
      </fieldset>
      {save.isError && <Alert>{save.error.message}</Alert>}
      {save.isSuccess && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Saved.
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** Sign-in → Directory (spec 12 §4.1): LDAP / LDAPS, checked when a password isn't ours. */
function DirectoryForm({ s }: { s: SettingsDto }) {
  const save = useSave();
  const d = s['auth.ldap'];
  const [v, setV] = useState({
    enabled: d?.enabled ?? false,
    preset: d?.preset ?? ('ad' as LdapInput['preset']),
    url: d?.url ?? '',
    startTls: d?.startTls ?? false,
    bindDn: d?.bindDn ?? '',
    bindPassword: '',
    baseDn: d?.baseDn ?? '',
    userFilter: d?.userFilter ?? LDAP_PRESETS.ad.userFilter,
    idAttribute: d?.idAttribute ?? LDAP_PRESETS.ad.idAttribute,
    emailAttribute: d?.emailAttribute ?? 'mail',
    nameAttribute: d?.nameAttribute ?? 'displayName',
    adminFilter: d?.adminFilter ?? '',
  });
  const [probe, setProbe] = useState({ testLogin: '', testPassword: '' });
  const input = (): LdapInput => ({ ...v, bindPassword: v.bindPassword || undefined });
  const test = useMutation({ mutationFn: () => settingsApi.testLdap({ ...input(), ...probe }) });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });
  const preset = (p: LdapInput['preset']) => {
    const x = LDAP_PRESETS[p];
    setV({
      ...v,
      preset: p,
      userFilter: x.userFilter,
      idAttribute: x.idAttribute,
      adminFilter: x.adminFilter,
    });
  };
  const text = (k: keyof typeof v, label: string, hint?: string, placeholder?: string) => (
    <Field label={label} hint={hint}>
      {(a) => (
        <input
          {...a}
          className={inputClass}
          placeholder={placeholder}
          value={v[k] as string}
          onChange={set(k)}
        />
      )}
    </Field>
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ 'auth.ldap': v.url.trim() ? input() : null });
        setV({ ...v, bindPassword: '' });
      }}
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-medium">Directory (LDAP)</legend>
        <p className="text-sm text-zinc-500">
          When a password isn&apos;t the one set here, SelfPhoneNG asks the directory. People sign
          in with their directory username or email; the first time, they&apos;re matched to their
          user here by email. Nobody gets a user just for being in the directory.
        </p>
        <p className="text-sm text-zinc-500">
          Every hour, someone no longer in the directory (or no longer matched by the user filter)
          is disabled here, password and OpenID sign-in included. It never enables anyone again: do
          that on Users.
        </p>
        {s['system.directoryWarning'] && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {s['system.directoryWarning']}
          </p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={v.enabled}
            onChange={(e) => setV({ ...v, enabled: e.target.checked })}
          />
          Check passwords against the directory
        </label>
        <Field label="Directory type" hint="Fills in the filters below; change them as needed">
          {(a) => (
            <select
              {...a}
              className={inputClass}
              value={v.preset}
              onChange={(e) => preset(e.target.value as LdapInput['preset'])}
            >
              {Object.entries(LDAP_PRESETS).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {text(
          'url',
          'Address',
          'ldaps:// (port 636), or ldap:// with StartTLS. Plain ldap:// only to this server itself.',
          'ldaps://dc1.example.com',
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={v.startTls}
            onChange={(e) => setV({ ...v, startTls: e.target.checked })}
          />
          StartTLS (for ldap:// addresses)
        </label>
        {text(
          'bindDn',
          'Service account DN',
          'An account that may search people. Empty: search anonymously.',
          'CN=pbx-search,OU=Service,DC=example,DC=com',
        )}
        <Field
          label="Service account password"
          hint={d?.hasBindPassword ? 'Saved. Type a new one to replace it.' : undefined}
        >
          {(a) => (
            <input
              {...a}
              type="password"
              autoComplete="off"
              placeholder={d?.hasBindPassword ? '••••••••' : ''}
              className={inputClass}
              value={v.bindPassword}
              onChange={set('bindPassword')}
            />
          )}
        </Field>
        {text(
          'baseDn',
          'Where people are',
          'Searched with everything under it',
          'DC=example,DC=com',
        )}
        {text(
          'userFilter',
          'User filter',
          '{login} is what they type. To allow one group only, add (memberOf=…) here.',
        )}
        {text(
          'adminFilter',
          'Admin filter',
          'People it matches are admins, the others users. Empty: you set roles on Users.',
        )}
        {text(
          'idAttribute',
          'ID attribute',
          'Never changes for a person: objectGUID, entryUUID, ipaUniqueID',
        )}
        {text('emailAttribute', 'Email attribute')}
        {text('nameAttribute', 'Name attribute')}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Test login (optional)" hint="Username or email">
            {(a) => (
              <input
                {...a}
                autoComplete="off"
                className={inputClass}
                value={probe.testLogin}
                onChange={(e) => setProbe({ ...probe, testLogin: e.target.value })}
              />
            )}
          </Field>
          <Field label="Its password" hint="Only used for this test, never stored">
            {(a) => (
              <input
                {...a}
                type="password"
                autoComplete="off"
                className={inputClass}
                value={probe.testPassword}
                onChange={(e) => setProbe({ ...probe, testPassword: e.target.value })}
              />
            )}
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => test.mutate()} disabled={test.isPending || !v.url.trim()}>
            Test
          </Button>
          {test.data && (
            <span
              role="status"
              className={`text-sm ${test.data.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}
            >
              {!test.data.ok
                ? test.data.error
                : `Works: ${test.data.matching >= 1000 ? '1000+' : test.data.matching} people match the user filter.` +
                  (test.data.user
                    ? ` ${test.data.user.dn}: ${test.data.user.email ?? 'no email'}, ${test.data.user.admin === null ? 'role set here' : test.data.user.admin ? 'admin' : 'user'}, ${test.data.user.matches ? `signs in as ${test.data.user.matches}` : 'no user here has that email'}.`
                    : '')}
            </span>
          )}
          {test.error && <Alert>{test.error.message}</Alert>}
        </div>
      </fieldset>
      {save.isError && <Alert>{save.error.message}</Alert>}
      {save.isSuccess && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Saved.
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}
