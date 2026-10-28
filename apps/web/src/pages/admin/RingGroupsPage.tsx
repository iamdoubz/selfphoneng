// SPDX-License-Identifier: AGPL-3.0-or-later
// Ring groups (05 §2, 03 §6.7): one number that rings several people, everyone at once or one at
// a time, then goes somewhere else when nobody answers.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  RingGroupCreateSchema,
  type Destination,
  type RingGroupCreate,
  type RingGroupDto,
} from '@selfphoneng/shared';
import { extensionsApi, ringGroupsApi } from '../../api/client.ts';
import { DestinationPicker } from '../../components/DestinationPicker.tsx';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

export function RingGroupsPage() {
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ['ring-groups'], queryFn: ringGroupsApi.list });
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const [editing, setEditing] = useState<RingGroupDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RingGroupDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['ring-groups'] });
  const remove = useMutation({
    mutationFn: (id: string) => ringGroupsApi.remove(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });
  const nameOf = (id: string) => exts.data?.find((x) => x.id === id)?.name ?? '?';

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Ring groups</h1>
        <Button variant="primary" onClick={() => setEditing('new')}>
          Add ring group
        </Button>
      </div>
      {groups.isError && <Alert>{groups.error.message}</Alert>}
      {groups.data?.length === 0 && (
        <p className="text-sm text-muted">
          No ring groups yet. A ring group is one number (like 500 for Sales) that rings several
          people.
        </p>
      )}
      {groups.data && groups.data.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-sm">
          {groups.data.map((g) => (
            <li
              key={g.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="font-mono">{g.number}</span>
              <span className="font-medium">{g.name}</span>
              <span className="min-w-0 flex-1 truncate text-muted">
                {g.strategy === 'ringall' ? 'Everyone at once' : 'One at a time'}:{' '}
                {g.memberIds.map(nameOf).join(', ') || 'nobody yet'} · then {g.noAnswerSummary}
              </span>
              <Button onClick={() => setEditing(g)}>Edit</Button>
              <Button variant="ghost" onClick={() => setDeleting(g)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <RingGroupForm
          group={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete ring group"
        message={
          <p>
            Delete ring group {deleting?.number} ({deleting?.name})?
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

function RingGroupForm({
  group,
  onClose,
  onSaved,
}: {
  group: RingGroupDto | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const next = useQuery({
    queryKey: ['next-number', 'ringGroup'],
    queryFn: () => extensionsApi.nextNumber('ringGroup'),
    enabled: !group,
  });
  const [form, setForm] = useState({
    number: group?.number ?? '',
    name: group?.name ?? '',
    strategy: group?.strategy ?? 'ringall',
    ringSeconds: String(group?.ringSeconds ?? 25),
    callerIdNamePrefix: group?.callerIdNamePrefix ?? '',
    musicInsteadOfRing: group?.musicInsteadOfRing ?? false,
  });
  const [members, setMembers] = useState<string[]>(group?.memberIds ?? []);
  const [dest, setDest] = useState<Destination | null>(
    group?.noAnswerDestination ?? { type: 'hangup' },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const number = form.number || (group ? '' : (next.data ?? ''));

  const save = useMutation({
    mutationFn: (body: RingGroupCreate) =>
      group ? ringGroupsApi.update(group.id, body) : ringGroupsApi.create(body),
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });

  function submit() {
    const parsed = RingGroupCreateSchema.safeParse({
      number,
      name: form.name,
      strategy: form.strategy,
      ringSeconds: Number(form.ringSeconds),
      callerIdNamePrefix: form.callerIdNamePrefix.trim() || null,
      musicInsteadOfRing: form.musicInsteadOfRing,
      memberIds: members,
      noAnswerDestination: dest ?? undefined,
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }

  const set = (k: keyof typeof form) => (v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const move = (i: number, by: number) =>
    setMembers((m) => {
      const out = [...m];
      [out[i], out[i + by]] = [out[i + by]!, out[i]!];
      return out;
    });
  const label = (id: string) => {
    const x = exts.data?.find((e) => e.id === id);
    return x ? `${x.number} ${x.name}` : '?';
  };
  const candidates = exts.data?.filter((x) => !members.includes(x.id)) ?? [];

  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={group ? `Ring group ${group.number}` : 'New ring group'}
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
              placeholder="Sales"
              onChange={(e) => set('name')(e.target.value)}
            />
          )}
        </Field>
        <Field label="How to ring">
          {(p) => (
            <select
              {...p}
              className={inputClass}
              value={form.strategy}
              onChange={(e) => set('strategy')(e.target.value)}
            >
              <option value="ringall">Everyone at once</option>
              <option value="hunt">One at a time, in order</option>
            </select>
          )}
        </Field>
        <Field
          label="Ring for (seconds)"
          error={errors.ringSeconds}
          hint={form.strategy === 'hunt' ? 'For each person' : 'In total'}
        >
          {(p) => (
            <input
              {...p}
              className={inputClass}
              inputMode="numeric"
              value={form.ringSeconds}
              onChange={(e) => set('ringSeconds')(e.target.value)}
            />
          )}
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Members</legend>
          {errors.memberIds && <Alert>{errors.memberIds}</Alert>}
          <ol className="flex flex-col gap-1">
            {members.map((m, i) => (
              <li key={m} className="flex items-center gap-2 text-sm">
                <span className="w-5 text-muted">{i + 1}.</span>
                <span className="flex-1">{label(m)}</span>
                <Button
                  className="px-2 py-1"
                  aria-label={`Move ${label(m)} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </Button>
                <Button
                  className="px-2 py-1"
                  aria-label={`Move ${label(m)} down`}
                  disabled={i === members.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </Button>
                <Button
                  variant="ghost"
                  className="px-2 py-1"
                  aria-label={`Remove ${label(m)}`}
                  onClick={() => setMembers((ms) => ms.filter((x) => x !== m))}
                >
                  ✕
                </Button>
              </li>
            ))}
          </ol>
          {candidates.length > 0 && (
            <select
              aria-label="Add a member"
              className={inputClass}
              value=""
              onChange={(e) => e.target.value && setMembers((m) => [...m, e.target.value])}
            >
              <option value="">Add a member…</option>
              {candidates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.number} {x.name}
                </option>
              ))}
            </select>
          )}
          <p className="text-xs text-muted">
            Members' call forwarding and voicemail don't apply here; Do not disturb does.
          </p>
        </fieldset>

        <DestinationPicker
          label="If nobody answers"
          value={dest ?? { type: 'hangup' }}
          onChange={setDest}
          error={errors.noAnswerDestination}
          exclude={group?.id}
        />
        <Field
          label="Caller name prefix"
          error={errors.callerIdNamePrefix}
          hint='Optional, e.g. "Sales:" so people know which line rings'
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
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.musicInsteadOfRing}
            onChange={(e) => set('musicInsteadOfRing')(e.target.checked)}
          />
          Callers hear music instead of ringing
        </label>
        {save.error && <Alert>{save.error.message}</Alert>}
      </div>
    </Dialog>
  );
}
