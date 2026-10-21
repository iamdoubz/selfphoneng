// SPDX-License-Identifier: AGPL-3.0-or-later
// First-run setup wizard (05 §2.1). Every step saves before moving on; some can be skipped.
// M3 also brings steps 7 (users) and 8 (main number routing) because "calls work using only the
// wizard" needs them; M6 adds "Ring everyone" to step 8 (an IVR needs a recorded greeting first).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { formatNumber, type Destination, type TrunkDto } from '@selfphoneng/shared';
import {
  didsApi,
  extensionsApi,
  ringGroupsApi,
  settingsApi,
  systemApi,
  trunksApi,
  usersApi,
} from '../api/client.ts';
import { DestinationPicker } from '../components/DestinationPicker.tsx';
import { ThemeToggle } from '../components/ThemeToggle.tsx';
import { Alert, Button, Field, inputClass } from '../components/ui.tsx';
import { subscribeLive, useLive } from '../live/store.ts';
import { EmailTab, EmergencyTab } from './admin/SettingsPage.tsx';
import { ImportNumbers, TrunkForm, trunkStatus } from './admin/TrunksPage.tsx';

const STEPS = [
  'Password',
  'Company',
  'Network',
  'Email',
  'Trunk',
  'Phone numbers',
  'Users',
  'Main number',
  'Emergency',
  'Done',
] as const;

export function SetupPage() {
  const [params, setParams] = useSearchParams();
  const step = Math.min(Math.max(Number(params.get('step') ?? 1), 1), STEPS.length);
  const go = (n: number) => setParams({ step: String(n) });
  const next = () => go(step + 1);
  const qc = useQueryClient();
  const nav = useNavigate();
  useEffect(subscribeLive, []);
  const finish = useMutation({
    mutationFn: systemApi.completeSetup,
    onSuccess: async () => {
      qc.setQueryData(['setup'], { completed: true }); // the admin layout reads it on mount
      nav('/admin', { replace: true });
    },
  });

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 p-4 md:p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Set up your phone system</h1>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="ghost" onClick={() => finish.mutate()}>
            Skip setup
          </Button>
        </div>
      </header>
      <ol aria-label="Steps" className="flex flex-wrap gap-1 text-xs">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => go(i + 1)}
              aria-current={step === i + 1 ? 'step' : undefined}
              className={`rounded-full px-2 py-1 ${step === i + 1 ? 'bg-sky-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800'}`}
            >
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>
      <section aria-labelledby="step-title" className="flex flex-col gap-4">
        <h2 id="step-title" className="text-lg font-medium">
          {step}. {STEPS[step - 1]}
        </h2>
        {step === 1 && <PasswordStep next={next} />}
        {step === 2 && <CompanyStep next={next} />}
        {step === 3 && <NetworkStep next={next} />}
        {step === 4 && <SettingsStep tab="email" next={next} skippable />}
        {step === 5 && <TrunkStep next={next} />}
        {step === 6 && <NumbersStep next={next} />}
        {step === 7 && <UsersStep next={next} />}
        {step === 8 && <RoutingStep next={next} />}
        {step === 9 && <SettingsStep tab="emergency" next={next} />}
        {step === 10 && <DoneStep onFinish={() => finish.mutate()} busy={finish.isPending} />}
      </section>
    </div>
  );
}

function Nav({
  next,
  canNext = true,
  skip,
  hint,
}: {
  next: () => void;
  canNext?: boolean;
  skip?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <Button variant="primary" onClick={next} disabled={!canNext}>
        Next
      </Button>
      {skip && (
        <Button variant="ghost" onClick={next}>
          {skip}
        </Button>
      )}
      {hint && <span className="text-sm text-zinc-500">{hint}</span>}
    </div>
  );
}

function PasswordStep({ next }: { next: () => void }) {
  // Signing in with the initial password already forced a change (RequireAuth).
  return (
    <>
      <p className="text-sm">✓ The initial admin password has been changed.</p>
      <Nav next={next} />
    </>
  );
}

function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
}

function CompanyStep({ next }: { next: () => void }) {
  const s = useSettings();
  if (!s.data) return <Loading q={s} />;
  return <CompanyForm initial={s.data} next={next} />;
}

function CompanyForm({
  initial,
  next,
}: {
  initial: { 'general.companyName': string; 'general.timezone': string };
  next: () => void;
}) {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [name, setName] = useState(initial['general.companyName']);
  const [tz, setTz] = useState(
    initial['general.companyName'] === 'My Company' ? browserTz : initial['general.timezone'],
  );
  const save = useMutation({ mutationFn: settingsApi.patch, onSuccess: next });
  const zones = Intl.supportedValuesOf('timeZone');
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          'general.companyName': name,
          'general.timezone': tz,
          'general.language': 'en',
        });
      }}
    >
      {save.isError && <Alert>{save.error.message}</Alert>}
      <Field label="Company name">
        {(a) => (
          <input
            {...a}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        )}
      </Field>
      <Field label="Time zone" hint="Office hours and call history use it.">
        {(a) => (
          <select {...a} value={tz} onChange={(e) => setTz(e.target.value)} className={inputClass}>
            {zones.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Language" hint="More languages later.">
        {(a) => (
          <select {...a} disabled className={inputClass}>
            <option>English</option>
          </select>
        )}
      </Field>
      <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <Button variant="primary" type="submit" disabled={save.isPending || !name.trim()}>
          Save and continue
        </Button>
      </div>
    </form>
  );
}

function NetworkStep({ next }: { next: () => void }) {
  const s = useSettings();
  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: systemApi.status,
  });
  if (!s.data || !status.data) return <Loading q={s} />;
  return (
    <NetworkForm
      next={next}
      publicIp={s.data['network.publicIp'] ?? ''}
      lanIp={s.data['network.lanIp'] ?? status.data.lanIps[0] ?? ''}
      lanIps={status.data.lanIps}
      rtpPorts={status.data.ports.rtp}
      localNets={s.data['network.localNets'].join(', ')}
    />
  );
}

function NetworkForm(p: {
  next: () => void;
  publicIp: string;
  lanIp: string;
  lanIps: string[];
  rtpPorts: string;
  localNets: string;
}) {
  const [publicIp, setPublicIp] = useState(p.publicIp);
  const [lanIp, setLanIp] = useState(p.lanIp);
  const [nets, setNets] = useState(p.localNets);
  const [done, setDone] = useState(false);
  const [note, setNote] = useState<string>();
  const detect = useMutation({
    mutationFn: systemApi.detectPublicIp,
    onSuccess: setPublicIp,
  });
  const save = useMutation({
    mutationFn: async () => {
      await settingsApi.patch({
        'network.publicIp': publicIp.trim() || null,
        'network.lanIp': lanIp.trim() || null,
        'network.localNets': nets.split(/[,\s]+/).filter(Boolean),
      });
      // New addresses change the SIP transports, which only load on a restart (01 §4.3).
      // A fresh install has no calls to drop, so restart right away.
      await new Promise((r) => setTimeout(r, 2000)); // let the debounced apply run
      if ((await systemApi.status()).restartRequired) {
        await systemApi.restartAsterisk(true);
        setNote('Telephony restarted to use the new addresses.');
      }
    },
    onSuccess: p.next,
  });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {(save.isError || detect.isError) && <Alert>{(save.error ?? detect.error)!.message}</Alert>}
      {note && (
        <p role="status" className="text-sm">
          {note}
        </p>
      )}
      <div className="flex items-end gap-2">
        <Field
          label="Public IP address"
          hint="Your internet address, so outside phones and voip.ms can reach this server."
        >
          {(a) => (
            <input
              {...a}
              value={publicIp}
              onChange={(e) => setPublicIp(e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
        <Button onClick={() => detect.mutate()} disabled={detect.isPending}>
          {detect.isPending ? 'Detecting…' : 'Detect public IP'}
        </Button>
      </div>
      <Field label="LAN IP address" hint="This server's address on your office network.">
        {(a) => (
          <>
            <input
              {...a}
              list="lan-ips"
              value={lanIp}
              onChange={(e) => setLanIp(e.target.value)}
              className={inputClass}
            />
            <datalist id="lan-ips">
              {p.lanIps.map((ip) => (
                <option key={ip} value={ip} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <Field
        label="Local networks"
        hint="Networks that reach this server without NAT, separated by commas."
      >
        {(a) => (
          <input
            {...a}
            value={nets}
            onChange={(e) => setNets(e.target.value)}
            className={inputClass}
          />
        )}
      </Field>
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
        <p className="font-medium">On your router:</p>
        <ol className="mt-1 list-decimal pl-5">
          <li>
            Turn off <strong>SIP ALG</strong> (sometimes called SIP helper). It rewrites calls and
            breaks them.
          </li>
          <li>
            Forward <strong>UDP 5060</strong> and <strong>UDP {p.rtpPorts}</strong> to this server (
            {lanIp || 'its LAN IP'}). Behind two routers, do it on both.
          </li>
        </ol>
        <label className="mt-2 flex items-center gap-2">
          <input
            type="checkbox"
            checked={done}
            onChange={(e) => setDone(e.target.checked)}
            className="size-4"
          />
          I&apos;ve done this
        </label>
      </div>
      <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <Button variant="primary" type="submit" disabled={save.isPending || !done}>
          {save.isPending ? 'Saving…' : 'Save and continue'}
        </Button>
      </div>
    </form>
  );
}

function SettingsStep({
  tab,
  next,
  skippable,
}: {
  tab: 'email' | 'emergency';
  next: () => void;
  skippable?: boolean;
}) {
  const s = useSettings();
  const trunks = useQuery({ queryKey: ['trunks'], queryFn: trunksApi.list });
  if (!s.data) return <Loading q={s} />;
  // 06 §6: once a trunk exists, an emergency caller ID is required.
  const needCid =
    tab === 'emergency' &&
    Boolean(trunks.data?.length) &&
    !s.data['emergency.defaultCallerIdDidId'];
  return (
    <>
      {tab === 'email' ? <EmailTab s={s.data} /> : <EmergencyTab s={s.data} />}
      <Nav
        next={next}
        canNext={!needCid}
        skip={skippable ? 'Skip for now' : undefined}
        hint={needCid ? 'Pick and save a default emergency caller ID first.' : undefined}
      />
    </>
  );
}

function TrunkStep({ next }: { next: () => void }) {
  const qc = useQueryClient();
  const trunks = useQuery({ queryKey: ['trunks'], queryFn: trunksApi.list });
  const [trunk, setTrunk] = useState<TrunkDto | null>(null);
  const t = trunk ?? trunks.data?.[0] ?? null;
  const live = useLive((s) => (t ? s.trunks[t.id] : undefined));
  if (!trunks.data) return <Loading q={trunks} />;
  const status = t ? trunkStatus(t, live) : null;
  const ok = status?.label === 'Registered' || status?.label === 'Reachable';
  return (
    <>
      <p className="text-sm text-zinc-500">
        Connect your voip.ms sub-account. Follow the checklist, save, and wait for{' '}
        <strong>Registered</strong>.
      </p>
      <TrunkForm
        trunk={t}
        onSaved={(saved) => {
          setTrunk(saved);
          void qc.invalidateQueries({ queryKey: ['trunks'] });
        }}
      />
      <div>
        <Button variant="primary" type="submit" form="trunk-form">
          {t ? 'Save trunk' : 'Create trunk'}
        </Button>
      </div>
      <Nav
        next={next}
        canNext={ok}
        skip="I'll add it later"
        hint={
          t && !ok ? `Status: ${status?.label}. Next unlocks when it is Registered.` : undefined
        }
      />
    </>
  );
}

function NumbersStep({ next }: { next: () => void }) {
  const qc = useQueryClient();
  const trunks = useQuery({ queryKey: ['trunks'], queryFn: trunksApi.list });
  const dids = useQuery({ queryKey: ['dids'], queryFn: didsApi.list });
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('Main line');
  const add = useMutation({
    mutationFn: () =>
      didsApi.create({
        number,
        label: label || null,
        trunkId: trunks.data![0]!.id,
        destination: { type: 'hangup' },
      }),
    onSuccess: () => {
      setNumber('');
      setLabel('');
      void qc.invalidateQueries({ queryKey: ['dids'] });
    },
  });
  if (!trunks.data || !dids.data) return <Loading q={dids} />;
  if (!trunks.data.length)
    return (
      <>
        <p className="text-sm">Numbers arrive through a trunk: add one first (step 5).</p>
        <Nav next={next} skip="Skip" canNext={false} />
      </>
    );
  return (
    <>
      <p className="text-sm text-zinc-500">
        Add the phone numbers (DIDs) you have at voip.ms. You choose where their calls go in step 8.
      </p>
      {trunks.data[0]!.hasApiPassword && <ImportNumbers trunk={trunks.data[0]!} />}
      {dids.data.length > 0 && (
        <ul className="text-sm">
          {dids.data.map((d) => (
            <li key={d.id}>
              ✓ {formatNumber(d.number)}{' '}
              {d.label && <span className="text-zinc-500">{d.label}</span>}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Phone number">
          {(a) => (
            <input
              {...a}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              inputMode="tel"
              placeholder="(312) 555-1234"
              className={inputClass}
            />
          )}
        </Field>
        <Field label="Label">
          {(a) => (
            <input
              {...a}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
        <Button type="submit" disabled={!number || add.isPending}>
          Add number
        </Button>
      </form>
      {add.isError && <Alert>{add.error.message}</Alert>}
      <Nav next={next} canNext={dids.data.length > 0} skip="Skip for now" />
    </>
  );
}

type NewUser = { name: string; email: string; number: string };

function UsersStep({ next }: { next: () => void }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: usersApi.list });
  const blank = { name: '', email: '', number: '' };
  const [rows, setRows] = useState<NewUser[]>([blank]);
  const [created, setCreated] = useState<
    { name: string; email: string; number: string; password: string }[]
  >([]);
  const save = useMutation({
    mutationFn: async () => {
      const out: typeof created = [];
      for (const r of rows.filter((x) => x.name.trim() && x.email.trim())) {
        const { user, temporaryPassword } = await usersApi.create({
          displayName: r.name.trim(),
          email: r.email.trim(),
          role: 'user',
        });
        // Their own number if typed in (any free one, 1 to 6 digits), else the next free.
        const number = r.number.trim() || (await extensionsApi.nextNumber('user'));
        if (number) await extensionsApi.create({ number, name: r.name.trim(), userId: user.id });
        out.push({
          name: r.name,
          email: r.email,
          number: number ?? '–',
          password: temporaryPassword,
        });
        setCreated([...out]);
      }
      return out;
    },
    onSettled: () => {
      setRows([blank]);
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['extensions'] });
    },
  });
  const set = (i: number, k: keyof NewUser, v: string) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const withExt = users.data?.filter((u) => u.extension) ?? [];

  return (
    <>
      <p className="text-sm text-zinc-500">
        Add the people who get a phone (up to 10 here; more later under Users &amp; Extensions).
        Each gets the extension you type (any free number, like 1), or the next free one, and a
        temporary password, shown once.
      </p>
      {withExt.length > 0 && (
        <ul className="text-sm">
          {withExt.map((u) => (
            <li key={u.id}>
              ✓ {u.extension!.number} {u.displayName}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[6rem_1fr_1fr] gap-2">
            <input
              aria-label={`Extension ${i + 1}`}
              placeholder="Next free"
              inputMode="numeric"
              pattern="[0-9]{1,6}"
              value={r.number}
              onChange={(e) => set(i, 'number', e.target.value)}
              className={inputClass}
            />
            <input
              aria-label={`Name ${i + 1}`}
              placeholder="Name"
              value={r.name}
              onChange={(e) => set(i, 'name', e.target.value)}
              className={inputClass}
            />
            <input
              aria-label={`Email ${i + 1}`}
              placeholder="Email"
              type="email"
              value={r.email}
              onChange={(e) => set(i, 'email', e.target.value)}
              className={inputClass}
            />
          </div>
        ))}
        <div className="flex gap-2">
          {rows.length < 10 && (
            <Button onClick={() => setRows([...rows, blank])}>Another person</Button>
          )}
          <Button variant="primary" type="submit" disabled={save.isPending}>
            Add users
          </Button>
        </div>
      </form>
      {save.isError && <Alert>{save.error.message}</Alert>}
      {created.length > 0 && (
        <div className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <p className="mb-2 font-medium">
            Give each person their temporary password (shown only now):
          </p>
          <table className="w-full">
            <tbody>
              {created.map((c) => (
                <tr key={c.email}>
                  <td>{c.number}</td>
                  <td>{c.name}</td>
                  <td className="text-zinc-500">{c.email}</td>
                  <td className="font-mono">{c.password}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Nav next={next} canNext={withExt.length > 0} skip="Skip for now" />
    </>
  );
}

function RoutingStep({ next }: { next: () => void }) {
  const qc = useQueryClient();
  const dids = useQuery({ queryKey: ['dids'], queryFn: didsApi.list });
  const [dest, setDest] = useState<Record<string, Destination | null>>({});
  /** A ring group "Everyone" with every extension (made once, kept up to date). */
  const everyone = useMutation({
    mutationFn: async () => {
      const exts = (await extensionsApi.list()).sort((a, b) => Number(a.number) - Number(b.number));
      if (!exts.length) throw new Error('Add users with extensions first (step 7)');
      const memberIds = exts.map((e) => e.id);
      const existing = (await ringGroupsApi.list()).find((g) => g.name === 'Everyone');
      const g = existing
        ? await ringGroupsApi.update(existing.id, { memberIds })
        : await ringGroupsApi.create({
            number: (await extensionsApi.nextNumber('ringGroup')) ?? '500',
            name: 'Everyone',
            memberIds,
            // Nobody picks up: the first person's voicemail rather than a dead end.
            noAnswerDestination: { type: 'voicemail', id: exts[0]!.id },
          });
      await qc.invalidateQueries({ queryKey: ['ring-groups'] });
      return g;
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      for (const [id, d] of Object.entries(dest))
        if (d) await didsApi.update(id, { destination: d });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dids'] });
      next();
    },
  });
  if (!dids.data) return <Loading q={dids} />;
  if (!dids.data.length)
    return (
      <>
        <p className="text-sm">No phone numbers yet (step 6).</p>
        <Nav next={next} />
      </>
    );
  const incomplete = Object.values(dest).some((d) => d === null);
  return (
    <>
      <p className="text-xs text-zinc-500">
        A digital receptionist ("press 1 for sales…") needs a recorded greeting: build it under
        Digital receptionist later and pick it here or on the Phone numbers page.
      </p>
      {dids.data.map((d) => {
        const value = dest[d.id] ?? d.destination;
        return (
          <div key={d.id} className="flex flex-col gap-2">
            <DestinationPicker
              // Re-mount when "Ring everyone" sets the value from outside.
              key={JSON.stringify(value)}
              label={`When someone calls ${formatNumber(d.number)}${d.label ? ` (${d.label})` : ''}, ring:`}
              value={value}
              onChange={(v) => setDest({ ...dest, [d.id]: v })}
            />
            <div>
              <Button
                disabled={everyone.isPending}
                onClick={() =>
                  everyone.mutate(undefined, {
                    onSuccess: (g) =>
                      setDest({ ...dest, [d.id]: { type: 'ring_group', id: g.id } }),
                  })
                }
              >
                Ring everyone
              </Button>
            </div>
          </div>
        );
      })}
      {everyone.isError && <Alert>{everyone.error.message}</Alert>}
      {save.isError && <Alert>{save.error.message}</Alert>}
      <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <Button
          variant="primary"
          onClick={() => save.mutate()}
          disabled={incomplete || save.isPending}
        >
          Save and continue
        </Button>
      </div>
    </>
  );
}

function DoneStep({ onFinish, busy }: { onFinish: () => void; busy: boolean }) {
  return (
    <>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        <li>
          Set up each desk phone or softphone app with the SIP details under Users &amp; Extensions
          → Credentials.
        </li>
        <li>Call your main number from a mobile phone: the phone you chose in step 8 rings.</li>
        <li>From a desk phone, call your mobile: it shows your main number as caller ID.</li>
        <li>Everything here can be changed later in the admin pages.</li>
      </ul>
      <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <Button variant="primary" onClick={onFinish} disabled={busy}>
          Finish
        </Button>
      </div>
    </>
  );
}

function Loading({ q }: { q: { isError: boolean; error: Error | null } }): ReactNode {
  return q.isError ? (
    <Alert>{q.error!.message}</Alert>
  ) : (
    <p className="text-sm text-zinc-500">Loading…</p>
  );
}
