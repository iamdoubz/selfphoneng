// SPDX-License-Identifier: AGPL-3.0-or-later
// My settings (05 §4): call forwarding, do not disturb, voicemail PIN and email options, the call
// report email, my Contrack account (11 §4.3).
// Softphone devices and notifications live in the softphone panel. "Set up a phone app" (07 §5).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatNumber, type CallReport, type MeDto, type MeUpdate } from '@selfphoneng/shared';
import { meApi } from '../../api/client.ts';
import { PhoneAppSetup } from '../../components/PhoneAppSetup.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

/** "102" stays as is; outside numbers get their usual format. */
export const showTarget = (n: string) => (n.length > 6 ? formatNumber(n) : n);

export function useMe() {
  return useQuery({ queryKey: ['me', 'settings'], queryFn: meApi.get });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (m: MeUpdate) => meApi.update(m),
    onSuccess: (me) => qc.setQueryData(['me', 'settings'], me),
  });
}

export function DndSwitch({ me }: { me: MeDto }) {
  const save = useUpdateMe();
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        role="switch"
        checked={me.dnd}
        disabled={save.isPending}
        onChange={(e) => save.mutate({ dnd: e.target.checked })}
      />
      Do not disturb
      <span className="text-xs text-zinc-500">(also *78 on, *79 off from your phone)</span>
    </label>
  );
}

export function MeSettingsPage() {
  const me = useMe();
  if (me.error) return <Alert>{me.error.message}</Alert>;
  if (!me.data) return <p className="text-sm text-zinc-500">Loading…</p>;
  // ponytail: the forms start from what was loaded; a *72 from the phone while this page is open
  // shows after a reload (remounting on every change would also wipe "Saved." and errors).
  return <SettingsForms me={me.data} />;
}

function SettingsForms({ me }: { me: MeDto }) {
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="fwd-h" className="flex flex-col gap-3">
        <h2 id="fwd-h" className="text-lg font-semibold">
          Calls
        </h2>
        <DndSwitch me={me} />
        <Forwarding me={me} />
      </section>
      {me.voicemailEnabled && <Voicemail me={me} />}
      <CallReportForm me={me} />
      {me.contrack && <ContrackConnect contrack={me.contrack} />}
      <section aria-labelledby="app-h" className="flex flex-col gap-3">
        <h2 id="app-h" className="text-lg font-semibold">
          Set up a phone app
        </h2>
        <PhoneAppSetup load={meApi.softphoneQr} />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Password</h2>
        <Link className="text-sm text-sky-700 underline dark:text-sky-400" to="/change-password">
          Change password
        </Link>
      </section>
    </div>
  );
}

const FORWARDS = [
  ['cfu', 'Forward all calls to', 'Your phones don’t ring at all (also *72<number> / *73)'],
  ['cfb', 'When you’re on a call, forward to', 'Instead of busy / voicemail'],
  ['cfna', 'When you don’t answer, forward to', 'Instead of voicemail'],
] as const;

function Forwarding({ me }: { me: MeDto }) {
  const save = useUpdateMe();
  const [form, setForm] = useState({
    cfu: me.cfu ? showTarget(me.cfu) : '',
    cfb: me.cfb ? showTarget(me.cfb) : '',
    cfna: me.cfna ? showTarget(me.cfna) : '',
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          cfu: form.cfu.trim() || null,
          cfb: form.cfb.trim() || null,
          cfna: form.cfna.trim() || null,
        });
      }}
    >
      {FORWARDS.map(([k, label, hint]) => (
        <Field key={k} label={label} hint={hint}>
          {(p) => (
            <input
              {...p}
              className={inputClass}
              inputMode="tel"
              placeholder="Off — or an extension or phone number"
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
            />
          )}
        </Field>
      ))}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save forwarding
        </Button>
        {save.isSuccess && <span className="text-sm text-zinc-500">Saved.</span>}
      </div>
      {save.error && <Alert>{save.error.message}</Alert>}
    </form>
  );
}

function Voicemail({ me }: { me: MeDto }) {
  const save = useUpdateMe();
  const [pin, setPin] = useState('');
  const [opts, setOpts] = useState({
    voicemailEmail: me.voicemailEmail,
    voicemailAttachAudio: me.voicemailAttachAudio,
    voicemailDeleteAfterEmail: me.voicemailDeleteAfterEmail,
  });
  const check = (k: keyof typeof opts, label: string, disabled = false) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={opts[k] && !disabled}
        disabled={disabled}
        onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })}
      />
      {label}
    </label>
  );
  return (
    <section aria-labelledby="vm-set-h" className="flex flex-col gap-3">
      <h2 id="vm-set-h" className="text-lg font-semibold">
        Voicemail
      </h2>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(
            {
              ...opts,
              voicemailDeleteAfterEmail:
                opts.voicemailDeleteAfterEmail && opts.voicemailAttachAudio && opts.voicemailEmail,
              ...(pin ? { voicemailPin: pin } : {}),
            },
            { onSuccess: () => setPin('') },
          );
        }}
      >
        <Field label="New voicemail PIN" hint="4 to 10 digits; leave empty to keep the current one">
          {(p) => (
            <input
              {...p}
              className={`${inputClass} max-w-48`}
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          )}
        </Field>
        {check('voicemailEmail', 'Email me new voicemails')}
        {check('voicemailAttachAudio', 'Attach the recording', !opts.voicemailEmail)}
        {check(
          'voicemailDeleteAfterEmail',
          'Delete it from the phone system once emailed',
          !opts.voicemailEmail || !opts.voicemailAttachAudio,
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Save voicemail settings
          </Button>
          {save.isSuccess && <span className="text-sm text-zinc-500">Saved.</span>}
        </div>
        {save.error && <Alert>{save.error.message}</Alert>}
      </form>
    </section>
  );
}

const REPORTS: [CallReport, string][] = [
  ['off', 'Off'],
  ['hourly', 'Every hour'],
  ['daily', 'Every day'],
  ['weekly', 'Every week'],
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function CallReportForm({ me }: { me: MeDto }) {
  const save = useUpdateMe();
  const [form, setForm] = useState({
    callReport: me.callReport,
    callReportTime: me.callReportTime,
    callReportWeekday: me.callReportWeekday,
    callReportSummaries: me.callReportSummaries,
  });
  const on = form.callReport !== 'off';
  return (
    <section aria-labelledby="report-h" className="flex flex-col gap-3">
      <h2 id="report-h" className="text-lg font-semibold">
        Call report
      </h2>
      <p className="text-sm text-zinc-500">
        An email listing your calls: who, which numbers, how long, and if they were recorded. No
        calls, no email. It goes out a few minutes after each period ends, in the company time zone.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(form);
        }}
      >
        <Field label="Email me">
          {(p) => (
            <select
              {...p}
              className={`${inputClass} max-w-48`}
              value={form.callReport}
              onChange={(e) => setForm({ ...form, callReport: e.target.value as CallReport })}
            >
              {REPORTS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {form.callReport === 'weekly' && (
          <Field label="On">
            {(p) => (
              <select
                {...p}
                className={`${inputClass} max-w-48`}
                value={form.callReportWeekday}
                onChange={(e) => setForm({ ...form, callReportWeekday: Number(e.target.value) })}
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {(form.callReport === 'daily' || form.callReport === 'weekly') && (
          <Field label="At" hint="Covers the day (or week) up to this time">
            {(p) => (
              <input
                {...p}
                type="time"
                required
                className={`${inputClass} max-w-48`}
                value={form.callReportTime}
                onChange={(e) => setForm({ ...form, callReportTime: e.target.value })}
              />
            )}
          </Field>
        )}
        {on && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.callReportSummaries}
              onChange={(e) => setForm({ ...form, callReportSummaries: e.target.checked })}
            />
            Add a summary of each recorded call
            <span className="text-xs text-zinc-500">(when your admin has call summaries on)</span>
          </label>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Save call report
          </Button>
          {save.isSuccess && <span className="text-sm text-zinc-500">Saved.</span>}
        </div>
        {save.error && <Alert>{save.error.message}</Alert>}
      </form>
    </section>
  );
}

/** Contrack mode (11 §4.3): my own Contrack account, through a personal token I make there. */
function ContrackConnect({ contrack }: { contrack: NonNullable<MeDto['contrack']> }) {
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const done = (me: MeDto) => {
    qc.setQueryData(['me', 'settings'], me);
    setToken('');
    void qc.invalidateQueries({ queryKey: ['contacts'] });
  };
  const connect = useMutation({ mutationFn: () => meApi.connectContrack(token), onSuccess: done });
  const disconnect = useMutation({ mutationFn: meApi.disconnectContrack, onSuccess: done });
  const options = useMutation({ mutationFn: meApi.contrackOptions, onSuccess: done });
  const where = contrack.publicUrl ? (
    <a
      className="text-sky-700 underline dark:text-sky-400"
      href={contrack.publicUrl}
      target="_blank"
      rel="noreferrer"
    >
      Contrack
    </a>
  ) : (
    'Contrack'
  );
  return (
    <section aria-labelledby="ctk-h" className="flex flex-col gap-3">
      <h2 id="ctk-h" className="text-lg font-semibold">
        Contacts
      </h2>
      {contrack.tokenPrefix && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>
            {contrack.connected ? 'Connected to your' : 'Your token for'} {where} account (
            {contrack.tokenPrefix})
            {!contrack.connected && (
              <span className="text-red-700 dark:text-red-400">: it doesn't work any more</span>
            )}
          </span>
          <Button onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
            Disconnect
          </Button>
        </div>
      )}
      {contrack.tokenPrefix && (
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={contrack.logCalls}
              disabled={options.isPending}
              onChange={(e) => options.mutate({ logCalls: e.target.checked })}
            />
            Put my calls on my contacts' timelines in Contrack
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={contrack.logSummaries && contrack.summariesAvailable}
              disabled={!contrack.logCalls || !contrack.summariesAvailable || options.isPending}
              onChange={(e) => options.mutate({ logSummaries: e.target.checked })}
            />
            <span>
              With the summary and action items of each recorded call
              {!contrack.summariesAvailable && (
                <span className="text-zinc-500"> (when your admin turns on call summaries)</span>
              )}
              <span className="block text-xs text-zinc-500">
                What was said goes into Contrack. If Contrack's own AI uses a cloud provider, it can
                reach that provider.
              </span>
            </span>
          </label>
        </div>
      )}
      {!contrack.tokenPrefix && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Your contacts live in your own {where} account. There, open Settings → Account → API
          tokens → Create token, with Read and write (so contacts shared with you can be added) and
          Expires: Never, and paste it here. Only you see your contacts unless you share them.
        </p>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          connect.mutate();
        }}
      >
        <Field label={contrack.tokenPrefix ? 'Replace the token' : 'Contrack token'}>
          {(p) => (
            <input
              {...p}
              type="password"
              autoComplete="off"
              placeholder="ctk_…"
              className={`${inputClass} w-72`}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={!token.trim() || connect.isPending}>
          Connect
        </Button>
      </form>
      {(connect.error ?? disconnect.error ?? options.error) && (
        <Alert>{(connect.error ?? disconnect.error)!.message}</Alert>
      )}
    </section>
  );
}
