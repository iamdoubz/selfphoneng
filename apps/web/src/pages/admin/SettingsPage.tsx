// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings (05 §2). M3: Email and Emergency; M7: Recording; M11: Network (public IP watch), Security (phone ACL, provisioning, SIP TLS), Backups,
// Webhooks, API tokens.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, useParams } from 'react-router';
import {
  WEBHOOK_EVENTS,
  formatNumber,
  type SettingsDto,
  type WebhookDto,
  type WebhookEvent,
} from '@selfphoneng/shared';
import {
  apiTokensApi,
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
  { id: 'network', label: 'Network' },
  { id: 'security', label: 'Security' },
  { id: 'backups', label: 'Backups' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'tokens', label: 'API tokens' },
] as const;

export function SettingsPage() {
  const { tab = 'email' } = useParams();
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <nav
        aria-label="Settings"
        className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800"
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
      {settings.data && tab === 'network' && <NetworkTab s={settings.data} />}
      {settings.data && tab === 'security' && <SecurityTab s={settings.data} />}
      {settings.data && tab === 'backups' && <BackupsTab s={settings.data} />}
      {settings.data && tab === 'webhooks' && <WebhooksTab s={settings.data} />}
      {tab === 'tokens' && <TokensTab />}
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
function NetworkTab({ s }: { s: SettingsDto }) {
  const save = useSave();
  const [ip, setIp] = useState(s['network.publicIp'] ?? '');
  const [watch, setWatch] = useState(s['network.publicIpWatch']);
  const detect = useMutation({ mutationFn: systemApi.detectPublicIp, onSuccess: setIp });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ 'network.publicIp': ip.trim() || null, 'network.publicIpWatch': watch });
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

/** Phone ACL (08 §2.2), provisioning access (07 §2) and SIP over TLS (M11-T2). */
function SecurityTab({ s }: { s: SettingsDto }) {
  const save = useSave();
  const cert = useQuery({ queryKey: ['tls'], queryFn: systemApi.tls });
  const [tlsOn, setTlsOn] = useState(s['sip.tlsEnabled']);
  const [tlsPort, setTlsPort] = useState(String(s['sip.tlsPort']));
  const [restrict, setRestrict] = useState(s['sip.restrictPhonesToLocalNets']);
  const [extra, setExtra] = useState(s['sip.extraAllowedNets'].join(', '));
  const [lanOnly, setLanOnly] = useState(s['provisioning.lanOnly']);
  const [provOn, setProvOn] = useState(s['provisioning.enabled']);
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
          'sip.tlsEnabled': tlsOn,
          'sip.tlsPort': Number(tlsPort),
        });
      }}
    >
      <h2 className="font-medium">Desk phones</h2>
      {box(restrict, setRestrict, 'Only accept desk phones from the networks below')}
      <p className="-mt-2 text-xs text-zinc-500">
        Local networks: {s['network.localNets'].join(', ')}. Phones anywhere else (at home, on a
        mobile network) can't sign in while this is on. Browser phones aren't affected.
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
      <h2 className="font-medium">Phone setup files</h2>
      {box(provOn, setProvOn, 'Serve setup files to phones (Phones page)')}
      {box(lanOnly, setLanOnly, 'Only to phones on the local networks')}
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
