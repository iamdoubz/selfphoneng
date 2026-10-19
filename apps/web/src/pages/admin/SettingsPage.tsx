// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings (05 §2). M3: Email and Emergency; M7: Recording; M11: Security (phone ACL, provisioning).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { formatNumber, type SettingsDto } from '@selfphoneng/shared';
import { didsApi, extensionsApi, settingsApi } from '../../api/client.ts';
import { SoundPicker } from '../../components/SoundPicker.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

const TABS = [
  { id: 'email', label: 'Email' },
  { id: 'emergency', label: 'Emergency' },
  { id: 'recording', label: 'Recording' },
  { id: 'security', label: 'Security' },
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
      {settings.data && tab === 'security' && <SecurityTab s={settings.data} />}
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
  const [notice, setNotice] = useState<string | null>(s['recordings.announcementSoundId']);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          'recordings.retentionDays': Number(days),
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

/** Phone ACL (08 §2.2) and provisioning access (07 §2). */
function SecurityTab({ s }: { s: SettingsDto }) {
  const save = useSave();
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
