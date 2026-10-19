// SPDX-License-Identifier: AGPL-3.0-or-later
// Queues (05 §2, 03 §6.8): callers wait with music until an agent is free. The list shows live
// counts; a queue's page shows who is waiting, the agents (pause/unpause) and today's numbers.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  QUEUE_STRATEGIES,
  QueueCreateSchema,
  type Destination,
  type QueueCreate,
  type QueueDto,
} from '@selfphoneng/shared';
import { extensionsApi, queuesApi } from '../../api/client.ts';
import { DestinationPicker } from '../../components/DestinationPicker.tsx';
import { MohOptions } from '../../components/MohOptions.tsx';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';
import { useLive } from '../../live/store.ts';
import { fmtNumber } from './CallsPage.tsx';
import { available, since, useNow } from './DashboardPage.tsx';

const STRATEGY_LABEL: Record<(typeof QUEUE_STRATEGIES)[number], string> = {
  rrmemory: 'Take turns (round robin)',
  leastrecent: 'Whoever finished a call longest ago',
  fewestcalls: 'Whoever took the fewest calls',
  ringall: 'Everyone at once',
  linear: 'In order, first agent first',
  random: 'Random agent',
};

export function QueuesPage() {
  const { id } = useParams();
  return id ? <QueueDetail id={id} /> : <QueueList />;
}

function QueueList() {
  const qc = useQueryClient();
  const queues = useQuery({ queryKey: ['queues'], queryFn: queuesApi.list });
  const live = useLive((s) => s.queues);
  const [editing, setEditing] = useState<QueueDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<QueueDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['queues'] });
  const remove = useMutation({
    mutationFn: (id: string) => queuesApi.remove(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Queues</h1>
        <Button variant="primary" onClick={() => setEditing('new')}>
          Add queue
        </Button>
      </div>
      {queues.isError && <Alert>{queues.error.message}</Alert>}
      {queues.data?.length === 0 && (
        <p className="text-sm text-zinc-500">
          No queues yet. In a queue (like 550 for Support) callers wait with music until one of the
          agents is free.
        </p>
      )}
      {queues.data && queues.data.length > 0 && (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {queues.data.map((q) => {
            const l = live[q.number];
            return (
              <li
                key={q.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
              >
                <span className="font-mono">{q.number}</span>
                <Link className="font-medium underline-offset-2 hover:underline" to={q.id}>
                  {q.name}
                </Link>
                <span className="min-w-0 flex-1 truncate text-zinc-500">
                  {q.members.length} agent{q.members.length === 1 ? '' : 's'}
                  {l ? ` · ${available(l)} available · ${l.waiting.length} waiting` : ''}
                </span>
                <Button onClick={() => setEditing(q)}>Edit</Button>
                <Button variant="ghost" onClick={() => setDeleting(q)}>
                  Delete
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <QueueForm
          queue={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete queue"
        message={
          <p>
            Delete queue {deleting?.number} ({deleting?.name})?
          </p>
        }
        confirmLabel="Delete"
        busy={remove.isPending}
        error={remove.error?.message}
        onCancel={() => {
          setDeleting(null);
          remove.reset();
        }}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </section>
  );
}

const STATE_LABEL: Record<string, string> = {
  idle: 'Free',
  inuse: 'On a call',
  busy: 'Busy',
  ringing: 'Ringing',
  ringinuse: 'Ringing',
  onhold: 'On hold',
  unavailable: 'Offline',
};

function QueueDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const queue = useQuery({ queryKey: ['queues', id], queryFn: () => queuesApi.get(id) });
  const stats = useQuery({
    queryKey: ['queues', id, 'stats'],
    queryFn: () => queuesApi.stats(id),
    refetchInterval: 30_000,
  });
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const live = useLive((s) => (queue.data ? s.queues[queue.data.number] : undefined));
  const now = useNow();
  const toggle = useMutation({
    mutationFn: ({ extId, paused }: { extId: string; paused: boolean }) =>
      queuesApi.setPaused(id, extId, paused),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queues', id] }),
  });

  if (queue.isError) return <Alert>{queue.error.message}</Alert>;
  if (!queue.data) return null;
  const q = queue.data;
  const s = stats.data;
  return (
    <section className="flex flex-col gap-6">
      <div>
        <Link className="text-sm text-zinc-500 hover:underline" to="..">
          ← Queues
        </Link>
        <h1 className="text-xl font-semibold">
          <span className="font-mono">{q.number}</span> {q.name}
        </h1>
        <p className="text-sm text-zinc-500">
          {STRATEGY_LABEL[q.strategy]} · waits up to {q.maxWaitSeconds} s, then {q.timeoutSummary}
        </p>
      </div>

      <div>
        <h2 className="mb-2 font-medium">Waiting</h2>
        {!live?.waiting.length ? (
          <p className="text-sm text-zinc-500">Nobody is waiting.</p>
        ) : (
          <ol
            aria-label="Waiting callers"
            className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800"
          >
            {live.waiting.map((w, i) => (
              <li key={w.linkedid} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="w-5 text-zinc-500">{i + 1}.</span>
                <span className="flex-1">
                  {w.callerName ? `${w.callerName} ` : ''}
                  <span className="text-zinc-500">{fmtNumber(w.callerNumber)}</span>
                </span>
                <span className="font-mono tabular-nums">{since(w.since, now)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div>
        <h2 className="mb-2 font-medium">Agents</h2>
        {toggle.error && <Alert>{toggle.error.message}</Alert>}
        {q.members.length === 0 ? (
          <p className="text-sm text-zinc-500">No agents yet. Add some with Edit.</p>
        ) : (
          <ul
            aria-label="Agents"
            className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800"
          >
            {q.members.map((m) => {
              const e = exts.data?.find((x) => x.id === m.extensionId);
              const l = live?.members.find((x) => x.ext === e?.number);
              const paused = l?.paused ?? m.paused;
              return (
                <li
                  key={m.extensionId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
                >
                  <span className="w-12 font-mono">{e?.number}</span>
                  <span className="min-w-0 flex-1 truncate">{e?.name}</span>
                  <span className="text-zinc-500">
                    {paused ? 'Paused' : STATE_LABEL[l?.state ?? 'unavailable']}
                    {l ? ` · ${l.callsTaken} call${l.callsTaken === 1 ? '' : 's'}` : ''}
                  </span>
                  <Button
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ extId: m.extensionId, paused: !paused })}
                  >
                    {paused ? `Unpause ${e?.number ?? ''}` : `Pause ${e?.number ?? ''}`}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-1 text-xs text-zinc-500">
          Agents can also log in and out from a phone with *45{q.number}.
        </p>
      </div>

      <div>
        <h2 className="mb-2 font-medium">Today</h2>
        <dl
          aria-label="Today's stats"
          className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6"
        >
          {(
            [
              ['Calls', s?.offered],
              ['Answered', s?.answered],
              ['Hung up waiting', s?.abandoned],
              ['Timed out', s?.timedOut],
              ['Average wait', s && (s.avgWaitSeconds === null ? '—' : `${s.avgWaitSeconds} s`)],
              [
                `Callers answered within ${q.slaSeconds} s`,
                s && (s.withinSlaPercent === null ? '—' : `${s.withinSlaPercent}%`),
              ],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <dt className="text-zinc-500">{k}</dt>
              <dd className="text-lg font-semibold">{v ?? '…'}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function QueueForm({
  queue,
  onClose,
  onSaved,
}: {
  queue: QueueDto | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const next = useQuery({
    queryKey: ['next-number', 'queue'],
    queryFn: () => extensionsApi.nextNumber('queue'),
    enabled: !queue,
  });
  const [form, setForm] = useState({
    number: queue?.number ?? '',
    name: queue?.name ?? '',
    strategy: queue?.strategy ?? 'rrmemory',
    memberRingSeconds: String(queue?.memberRingSeconds ?? 15),
    retrySeconds: String(queue?.retrySeconds ?? 5),
    wrapupSeconds: String(queue?.wrapupSeconds ?? 10),
    maxWaitSeconds: String(queue?.maxWaitSeconds ?? 300),
    maxCallers: String(queue?.maxCallers ?? 0),
    mohClass: queue?.mohClass ?? 'default',
    announcePosition: queue?.announcePosition ?? true,
    announceEverySeconds: String(queue?.announceEverySeconds ?? 60),
    joinWhenNoAgents: queue?.joinWhenNoAgents ?? false,
    record: queue?.record ?? false,
    slaSeconds: String(queue?.slaSeconds ?? 20),
    callerIdNamePrefix: queue?.callerIdNamePrefix ?? '',
  });
  const [members, setMembers] = useState(
    queue?.members.map(({ extensionId, penalty }) => ({ extensionId, penalty })) ?? [],
  );
  const [dest, setDest] = useState<Destination | null>(
    queue?.timeoutDestination ?? { type: 'hangup' },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const number = form.number || (queue ? '' : (next.data ?? ''));

  const save = useMutation({
    mutationFn: (body: QueueCreate) =>
      queue ? queuesApi.update(queue.id, body) : queuesApi.create(body),
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });

  function submit() {
    const n = (k: keyof typeof form) => Number(form[k]);
    const parsed = QueueCreateSchema.safeParse({
      number,
      name: form.name,
      strategy: form.strategy,
      memberRingSeconds: n('memberRingSeconds'),
      retrySeconds: n('retrySeconds'),
      wrapupSeconds: n('wrapupSeconds'),
      maxWaitSeconds: n('maxWaitSeconds'),
      maxCallers: n('maxCallers'),
      mohClass: form.mohClass,
      announcePosition: form.announcePosition,
      announceEverySeconds: n('announceEverySeconds'),
      joinWhenNoAgents: form.joinWhenNoAgents,
      record: form.record,
      slaSeconds: n('slaSeconds'),
      callerIdNamePrefix: form.callerIdNamePrefix.trim() || null,
      members,
      timeoutDestination: dest ?? undefined,
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }

  const set = (k: keyof typeof form) => (v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const label = (id: string) => {
    const x = exts.data?.find((e) => e.id === id);
    return x ? `${x.number} ${x.name}` : '?';
  };
  const candidates = exts.data?.filter((x) => !members.some((m) => m.extensionId === x.id)) ?? [];
  const num = (k: keyof typeof form, lbl: string, hint?: string) => (
    <Field label={lbl} error={errors[k]} hint={hint}>
      {(p) => (
        <input
          {...p}
          className={inputClass}
          inputMode="numeric"
          value={String(form[k])}
          onChange={(e) => set(k)(e.target.value)}
        />
      )}
    </Field>
  );

  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={queue ? `Queue ${queue.number}` : 'New queue'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Number" error={errors.number} hint="Callers and colleagues dial this">
          {(p) => (
            <input
              {...p}
              className={inputClass}
              inputMode="numeric"
              value={number}
              onChange={(e) => set('number')(e.target.value)}
            />
          )}
        </Field>
        <Field label="Name" error={errors.name}>
          {(p) => (
            <input
              {...p}
              className={inputClass}
              value={form.name}
              placeholder="Support"
              onChange={(e) => set('name')(e.target.value)}
            />
          )}
        </Field>
        <Field label="Who gets the next call">
          {(p) => (
            <select
              {...p}
              className={inputClass}
              value={form.strategy}
              onChange={(e) => set('strategy')(e.target.value)}
            >
              {QUEUE_STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {STRATEGY_LABEL[s]}
                </option>
              ))}
            </select>
          )}
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Agents</legend>
          {errors.members && <Alert>{errors.members}</Alert>}
          <ul className="flex flex-col gap-1">
            {members.map((m) => (
              <li key={m.extensionId} className="flex items-center gap-2 text-sm">
                <span className="flex-1">{label(m.extensionId)}</span>
                <label className="flex items-center gap-1 text-zinc-500">
                  Priority
                  <select
                    aria-label={`Priority of ${label(m.extensionId)}`}
                    className={`${inputClass} w-16`}
                    value={m.penalty}
                    onChange={(e) =>
                      setMembers((ms) =>
                        ms.map((x) =>
                          x.extensionId === m.extensionId
                            ? { ...x, penalty: Number(e.target.value) }
                            : x,
                        ),
                      )
                    }
                  >
                    {Array.from({ length: 11 }, (_, i) => (
                      <option key={i} value={i}>
                        {i}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="ghost"
                  className="px-2 py-1"
                  aria-label={`Remove ${label(m.extensionId)}`}
                  onClick={() =>
                    setMembers((ms) => ms.filter((x) => x.extensionId !== m.extensionId))
                  }
                >
                  ✕
                </Button>
              </li>
            ))}
          </ul>
          {candidates.length > 0 && (
            <select
              aria-label="Add an agent"
              className={inputClass}
              value=""
              onChange={(e) =>
                e.target.value &&
                setMembers((ms) => [...ms, { extensionId: e.target.value, penalty: 0 }])
              }
            >
              <option value="">Add an agent…</option>
              {candidates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.number} {x.name}
                </option>
              ))}
            </select>
          )}
          <p className="text-xs text-zinc-500">
            Priority 0 gets calls first; higher numbers only when the lower ones are all busy.
          </p>
        </fieldset>

        {num(
          'maxWaitSeconds',
          'Longest wait (seconds)',
          'Then the caller goes on to the next step',
        )}
        <DestinationPicker
          label="When the wait is too long, the queue is full, or no agent is logged in"
          value={dest ?? { type: 'hangup' }}
          onChange={setDest}
          error={errors.timeoutDestination}
          exclude={queue?.id}
        />
        {num('memberRingSeconds', 'Ring each agent for (seconds)')}
        {num('retrySeconds', 'Pause before trying the next agent (seconds)')}
        {num(
          'wrapupSeconds',
          'Break after each call (seconds)',
          'Time for notes before the next call',
        )}
        {num('maxCallers', 'Most callers waiting', '0 = no limit')}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.joinWhenNoAgents}
            onChange={(e) => set('joinWhenNoAgents')(e.target.checked)}
          />
          Let callers wait even when no agent is logged in
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.announcePosition}
            onChange={(e) => set('announcePosition')(e.target.checked)}
          />
          Tell callers their place in line
        </label>
        {form.announcePosition && num('announceEverySeconds', 'Every (seconds)')}
        <Field label="Music on hold" error={errors.mohClass} hint="Add music on Sounds & music">
          {(p) => (
            <select
              {...p}
              className={inputClass}
              value={form.mohClass}
              onChange={(e) => set('mohClass')(e.target.value)}
            >
              <MohOptions current={queue?.mohClass ?? 'default'} />
            </select>
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.record}
            onChange={(e) => set('record')(e.target.checked)}
          />
          Record calls
        </label>
        {num('slaSeconds', 'Target answer time (seconds)', 'For the "answered within" figure')}
        <Field
          label="Caller name prefix"
          error={errors.callerIdNamePrefix}
          hint='Optional, e.g. "Support:" so agents know which queue rings'
        >
          {(p) => (
            <input
              {...p}
              className={inputClass}
              value={form.callerIdNamePrefix}
              onChange={(e) => set('callerIdNamePrefix')(e.target.value)}
            />
          )}
        </Field>
        {save.error && <Alert>{save.error.message}</Alert>}
      </div>
    </Dialog>
  );
}
