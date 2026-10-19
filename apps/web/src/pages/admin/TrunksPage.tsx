// SPDX-License-Identifier: AGPL-3.0-or-later
// Trunks (05 §2, 06 §1–§2): list with live status, voip.ms-first form with the portal checklist.
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import {
  CODECS,
  formatNumber,
  Hostname,
  VOIPMS_SERVERS,
  type TrunkDto,
  type TrunkLive,
  type TrunkTestResult,
} from '@selfphoneng/shared';
import { trunksApi } from '../../api/client.ts';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';
import { useLive } from '../../live/store.ts';

export function trunkStatus(t: Pick<TrunkDto, 'enabled' | 'authMode'>, live?: TrunkLive) {
  if (!t.enabled)
    return { label: 'Off', color: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' };
  const ok = 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200';
  const bad = 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200';
  const wait = 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200';
  if (!live) return { label: 'Unknown', color: wait };
  if (t.authMode === 'ip')
    return live.reachable
      ? { label: 'Reachable', color: ok }
      : { label: 'Unreachable', color: bad };
  if (live.registration === 'registered') return { label: 'Registered', color: ok };
  if (live.registration === 'rejected') return { label: 'Rejected', color: bad };
  return { label: 'Not registered', color: wait };
}

function StatusPill({ t }: { t: TrunkDto }) {
  const live = useLive((s) => s.trunks[t.id]);
  const s = trunkStatus(t, live);
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.color}`}>{s.label}</span>
  );
}

export function TrunksPage() {
  const qc = useQueryClient();
  const trunks = useQuery({ queryKey: ['trunks'], queryFn: trunksApi.list });
  const [editing, setEditing] = useState<TrunkDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<TrunkDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['trunks'] });
  const remove = useMutation({
    mutationFn: (id: string) => trunksApi.remove(id),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Trunks</h1>
        <Button variant="primary" onClick={() => setEditing('new')}>
          New trunk
        </Button>
      </div>
      <p className="max-w-prose text-sm text-zinc-500">
        A trunk connects the phone system to your phone company (voip.ms or any SIP provider), so
        calls can go to and come from the outside world.
      </p>
      {trunks.isError && <Alert>{trunks.error.message}</Alert>}
      {trunks.isPending && <p className="text-sm text-zinc-500">Loading…</p>}
      {trunks.data?.length === 0 && (
        <p className="text-sm text-zinc-500">No trunks yet. Add your voip.ms sub-account.</p>
      )}
      {trunks.data && trunks.data.length > 0 && (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {trunks.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <StatusPill t={t} />
              <span className="font-medium">{t.name}</span>
              <span className="flex-1 truncate text-zinc-500">
                {t.username ? `${t.username}@` : ''}
                {t.serverHost}
              </span>
              <Button onClick={() => setEditing(t)}>Edit</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  remove.reset();
                  setDeleting(t);
                }}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <TrunkDrawer
          trunk={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            void refresh();
            setEditing(t); // stay open so the admin can press Test
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete trunk"
        message={
          <p>
            Delete <strong>{deleting?.name}</strong>? Calls can no longer use it.
          </p>
        }
        confirmLabel="Delete"
        busy={remove.isPending}
        error={remove.error?.message}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </section>
  );
}

const FormSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(40),
  provider: z.enum(['voipms', 'generic']),
  enabled: z.boolean(),
  serverHost: Hostname,
  serverPort: z.number({ error: 'A port number' }).int().min(1).max(65535),
  transport: z.enum(['udp', 'tcp', 'tls']),
  authMode: z.enum(['registration', 'ip']),
  username: z.string().trim().max(64),
  password: z.string().max(128),
  fromUser: z.string().trim().max(64),
  fromDomain: z.union([z.literal(''), Hostname]),
  codecs: z.array(z.enum(CODECS)).min(1, 'Pick at least one codec'),
  srtp: z.boolean(),
  maxChannels: z.string().regex(/^(\d{1,4})?$/, 'A number, or empty for no limit'),
  voipmsApiUsername: z.string().trim().max(254),
  voipmsApiPassword: z.string().max(128),
});
type FormValues = z.infer<typeof FormSchema>;

function TrunkDrawer({
  trunk,
  onClose,
  onSaved,
}: {
  trunk: TrunkDto | null;
  onClose: () => void;
  onSaved: (t: TrunkDto) => void;
}) {
  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={trunk ? `Edit ${trunk.name}` : 'New trunk'}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" type="submit" form="trunk-form">
            {trunk ? 'Save' : 'Create trunk'}
          </Button>
        </>
      }
    >
      <TrunkForm trunk={trunk} onSaved={onSaved} />
    </Dialog>
  );
}

/** The trunk form (id "trunk-form"); the caller renders the submit button. Also used by /setup. */
export function TrunkForm({
  trunk,
  onSaved,
}: {
  trunk: TrunkDto | null;
  onSaved: (t: TrunkDto) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      name: trunk?.name ?? 'voip.ms',
      provider: trunk?.provider ?? 'voipms',
      enabled: trunk?.enabled ?? true,
      serverHost: trunk?.serverHost ?? '',
      serverPort: trunk?.serverPort ?? 5060,
      transport: trunk?.transport ?? 'udp',
      authMode: trunk?.authMode ?? 'registration',
      username: trunk?.username ?? '',
      password: '',
      fromUser: trunk?.fromUser ?? '',
      fromDomain: trunk?.fromDomain ?? '',
      codecs: trunk?.codecs ?? ['ulaw'],
      srtp: trunk?.srtp ?? false,
      maxChannels: trunk?.maxChannels ? String(trunk.maxChannels) : '',
      voipmsApiUsername: trunk?.voipmsApiUsername ?? '',
      voipmsApiPassword: '',
    },
  });
  const { errors } = form.formState;
  const [provider, authMode, transport] = useWatch({
    control: form.control,
    name: ['provider', 'authMode', 'transport'],
  });
  const voipms = provider === 'voipms';
  // The account's POP servers once the trunk has API access (06 §2); the built-in list otherwise.
  const servers = useQuery({
    queryKey: ['voipms-servers', trunk?.id],
    queryFn: () => trunksApi.voipmsServers(trunk!.id),
    enabled: voipms && !!trunk?.hasApiPassword,
    retry: false,
  });

  function setTransport(t: FormValues['transport']) {
    form.setValue('transport', t);
    form.setValue('serverPort', t === 'tls' ? 5061 : 5060);
    if (t !== 'tls') form.setValue('srtp', false);
  }

  const onSubmit = form.handleSubmit(async (v) => {
    setError(undefined);
    const body = {
      ...v,
      username: v.username || null,
      fromUser: v.fromUser || null,
      fromDomain: v.fromDomain || null,
      maxChannels: v.maxChannels ? Number(v.maxChannels) : null,
      voipmsApiUsername: v.voipmsApiUsername || null,
      // Empty password fields mean "keep the stored one".
      password: v.password || undefined,
      voipmsApiPassword: v.voipmsApiPassword || undefined,
    };
    try {
      const t = trunk ? await trunksApi.update(trunk.id, body) : await trunksApi.create(body);
      form.reset({ ...v, password: '', voipmsApiPassword: '' });
      // New API login: ask voip.ms again.
      void qc.invalidateQueries({ queryKey: ['voipms-servers', t.id] });
      void qc.invalidateQueries({ queryKey: ['voipms-dids', t.id] });
      setSaved(true);
      onSaved(t);
    } catch (e) {
      setError((e as Error).message);
    }
  });

  return (
    <form id="trunk-form" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {error && <Alert>{error}</Alert>}
      {saved && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Saved. The phone system picks it up within a few seconds.
        </p>
      )}
      {trunk && <TestPanel trunk={trunk} />}
      <Field label="Provider">
        {(a) => (
          <select {...a} {...form.register('provider')} className={inputClass}>
            <option value="voipms">voip.ms</option>
            <option value="generic">Other SIP provider</option>
          </select>
        )}
      </Field>
      {voipms && <VoipmsChecklist />}
      <Field label="Name" error={errors.name?.message}>
        {(a) => <input {...a} {...form.register('name')} className={inputClass} />}
      </Field>
      <Field
        label="Server"
        error={errors.serverHost?.message}
        hint={
          !voipms
            ? undefined
            : servers.isError
              ? `The voip.ms POP your sub-account and numbers use. (Couldn't get the list from voip.ms: ${servers.error.message})`
              : 'The voip.ms POP your sub-account and numbers use.'
        }
      >
        {(a) => (
          <>
            <input
              {...a}
              {...form.register('serverHost')}
              list={voipms ? 'voipms-servers' : undefined}
              placeholder={voipms ? 'chicago1.voip.ms' : 'sip.example.com'}
              autoComplete="off"
              className={inputClass}
            />
            <datalist id="voipms-servers">
              {(servers.data ?? VOIPMS_SERVERS).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <Field label="Sign-in">
        {(a) => (
          <select {...a} {...form.register('authMode')} className={inputClass}>
            <option value="registration">Username and password (registration)</option>
            <option value="ip">IP address (the provider knows this server's IP)</option>
          </select>
        )}
      </Field>
      {authMode === 'registration' && (
        <>
          <Field
            label={voipms ? 'Sub-account username' : 'Username'}
            error={errors.username?.message}
            hint={voipms ? 'Like 123456_pbx.' : undefined}
          >
            {(a) => (
              <input
                {...a}
                {...form.register('username')}
                autoComplete="off"
                className={inputClass}
              />
            )}
          </Field>
          <Field
            label="Password"
            error={errors.password?.message}
            hint={trunk?.hasPassword ? 'Leave empty to keep the current password.' : undefined}
          >
            {(a) => (
              <input
                {...a}
                {...form.register('password')}
                type="password"
                autoComplete="new-password"
                className={inputClass}
              />
            )}
          </Field>
        </>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Transport">
          {(a) => (
            <select
              {...a}
              value={transport}
              onChange={(e) => setTransport(e.target.value as FormValues['transport'])}
              className={inputClass}
            >
              <option value="udp">UDP</option>
              <option value="tcp">TCP</option>
              <option value="tls">TLS (encrypted)</option>
            </select>
          )}
        </Field>
        <Field label="Port" error={errors.serverPort?.message}>
          {(a) => (
            <input
              {...a}
              {...form.register('serverPort', { valueAsNumber: true })}
              type="number"
              className={inputClass}
            />
          )}
        </Field>
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">Codecs</legend>
        <div className="flex gap-4">
          {CODECS.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <input type="checkbox" value={c} {...form.register('codecs')} className="size-4" />
              {c === 'ulaw' ? 'G.711 µ-law' : c === 'alaw' ? 'G.711 A-law' : 'G.722 (HD)'}
            </label>
          ))}
        </div>
        {errors.codecs && (
          <p className="text-xs text-red-600 dark:text-red-400">{errors.codecs.message}</p>
        )}
      </fieldset>
      <Field
        label="Max simultaneous calls"
        error={errors.maxChannels?.message}
        hint="Empty for no limit."
      >
        {(a) => (
          <input
            {...a}
            {...form.register('maxChannels')}
            inputMode="numeric"
            className={inputClass}
          />
        )}
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" {...form.register('enabled')} className="size-4" />
        Enabled
      </label>

      <details className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
        <summary className="cursor-pointer font-medium">Advanced</summary>
        <div className="mt-3 flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              {...form.register('srtp')}
              disabled={transport !== 'tls'}
              className="size-4"
            />
            Encrypt audio (SRTP, needs TLS)
          </label>
          <Field
            label="From user"
            error={errors.fromUser?.message}
            hint="Defaults to the username."
          >
            {(a) => <input {...a} {...form.register('fromUser')} className={inputClass} />}
          </Field>
          <Field
            label="From domain"
            error={errors.fromDomain?.message}
            hint="Defaults to the server."
          >
            {(a) => <input {...a} {...form.register('fromDomain')} className={inputClass} />}
          </Field>
        </div>
      </details>

      {voipms && (
        <details className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <summary className="cursor-pointer font-medium">voip.ms API (optional)</summary>
          <div className="mt-3 flex flex-col gap-4">
            <p className="text-zinc-500">
              Needed for SMS and importing your numbers. In the voip.ms portal: Main Menu → SOAP and
              REST/JSON API. Enable it, set an API password, and allow this server's public IP
              address.
            </p>
            <Field label="API username (your voip.ms email)">
              {(a) => (
                <input
                  {...a}
                  {...form.register('voipmsApiUsername')}
                  type="email"
                  autoComplete="off"
                  className={inputClass}
                />
              )}
            </Field>
            <Field
              label="API password"
              hint={trunk?.hasApiPassword ? 'Leave empty to keep the current password.' : undefined}
            >
              {(a) => (
                <input
                  {...a}
                  {...form.register('voipmsApiPassword')}
                  type="password"
                  autoComplete="new-password"
                  className={inputClass}
                />
              )}
            </Field>
            {trunk?.hasApiPassword && <ImportNumbers trunk={trunk} />}
          </div>
        </details>
      )}
    </form>
  );
}

/** "Import numbers from voip.ms" (06 §7): the account's DIDs with checkboxes. Also in /setup. */
export function ImportNumbers({ trunk }: { trunk: TrunkDto }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [done, setDone] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ['voipms-dids', trunk.id],
    queryFn: () => trunksApi.voipmsDids(trunk.id),
    enabled: open,
    retry: false,
  });
  const run = useMutation({
    mutationFn: () => trunksApi.importDids(trunk.id, picked),
    onSuccess: async (r) => {
      setDone(r.added);
      setPicked([]);
      await qc.invalidateQueries({ queryKey: ['dids'] });
      await list.refetch();
    },
  });
  if (!open)
    return (
      <div>
        <Button onClick={() => setOpen(true)}>Import numbers from voip.ms</Button>
      </div>
    );
  const fresh = list.data?.filter((d) => !d.added) ?? [];
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-medium">Your voip.ms numbers</legend>
      {list.isPending && <p className="text-zinc-500">Asking voip.ms…</p>}
      {list.isError && <Alert>{list.error.message}</Alert>}
      {list.data?.length === 0 && <p className="text-zinc-500">voip.ms lists no numbers.</p>}
      {list.data?.map((d) => (
        <label key={d.number} className="flex items-center gap-2">
          <input
            type="checkbox"
            disabled={d.added}
            checked={d.added || picked.includes(d.number)}
            onChange={(e) =>
              setPicked((p) =>
                e.target.checked ? [...p, d.number] : p.filter((n) => n !== d.number),
              )
            }
          />
          {formatNumber(d.number)}
          {d.description && <span className="text-zinc-500">{d.description}</span>}
          {d.added && <span className="text-zinc-500">(added)</span>}
        </label>
      ))}
      {fresh.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={!picked.length || run.isPending}
            onClick={() => run.mutate()}
          >
            Import {picked.length || ''} {picked.length === 1 ? 'number' : 'numbers'}
          </Button>
          <Button onClick={() => setPicked(fresh.map((d) => d.number))}>Pick all</Button>
        </div>
      )}
      {done !== null && (
        <p role="status" className="text-green-700 dark:text-green-400">
          Added {done}. They hang up until you choose where their calls go (Phone numbers).
        </p>
      )}
      {run.error && <Alert>{run.error.message}</Alert>}
    </fieldset>
  );
}

function TestPanel({ trunk }: { trunk: TrunkDto }) {
  const [result, setResult] = useState<TrunkTestResult | { error: string } | null>(null);
  const test = useMutation({
    mutationFn: () => trunksApi.test(trunk.id),
    onSuccess: setResult,
    onError: (e) => setResult({ error: e.message }),
  });
  const live = useLive((s) => s.trunks[trunk.id]);
  const status = trunkStatus(trunk, live);
  return (
    <div className="flex flex-col gap-2 rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.color}`}>
          {status.label}
        </span>
        <span className="flex-1" />
        <Button onClick={() => test.mutate()} disabled={test.isPending || !trunk.enabled}>
          {test.isPending ? 'Testing…' : 'Test'}
        </Button>
      </div>
      {result && (
        <p role="status">
          {'error' in result
            ? result.error
            : `${result.detail}${result.rttMs !== null ? ` (${result.rttMs} ms)` : ''}`}
        </p>
      )}
    </div>
  );
}

/** What the customer sets in the voip.ms portal (06 §1). */
function VoipmsChecklist() {
  return (
    <details className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm dark:border-sky-900 dark:bg-sky-950/40">
      <summary className="cursor-pointer font-medium">Set up voip.ms first (checklist)</summary>
      <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5">
        <li>
          <strong>Create a sub-account</strong> (Main Menu → Sub Accounts → Create), one per phone
          system, e.g. <code>123456_pbx</code>: authentication <em>User/Password</em>, a strong
          random password, device type <em>Asterisk, IP PBX, Gateway or VoIP Switch</em>, codec{' '}
          <em>G.711u</em>, DTMF <em>RFC 2833</em>, NAT <em>Yes</em>, CallerID number = your main
          number, international calling <em>off</em> unless you need it.
        </li>
        <li>
          <strong>Pick a POP server</strong> close to you (e.g. chicago1.voip.ms). Enter the same
          one below.
        </li>
        <li>
          <strong>Point each number at the sub-account</strong> (DID Numbers → Manage DIDs → edit):
          routing <em>SIP/IAX → the sub-account</em>, and the <em>same POP server</em>. A different
          POP is a common reason incoming calls fail.
        </li>
        <li>
          <strong>Register an E911 address</strong> for every number used as an emergency caller ID
          (DID → e911).
        </li>
        <li>
          <strong>Set balance alerts</strong> and per-call or daily limits in your voip.ms account
          settings.
        </li>
      </ol>
    </details>
  );
}
