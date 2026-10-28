// SPDX-License-Identifier: AGPL-3.0-or-later
// Conference rooms (05 §2, 03 §6.11): number, name, PIN, admin PIN, max members, record.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ConferenceCreateSchema,
  type ConferenceCreate,
  type ConferenceDto,
} from '@selfphoneng/shared';
import { conferencesApi, extensionsApi } from '../../api/client.ts';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

export function ConferencesPage() {
  const qc = useQueryClient();
  const rooms = useQuery({ queryKey: ['conferences'], queryFn: conferencesApi.list });
  const [editing, setEditing] = useState<ConferenceDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ConferenceDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['conferences'] });
  const remove = useMutation({
    mutationFn: (id: string) => conferencesApi.remove(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Conference rooms</h1>
        <Button variant="primary" onClick={() => setEditing('new')}>
          Add room
        </Button>
      </div>
      {rooms.isError && <Alert>{rooms.error.message}</Alert>}
      {rooms.data?.length === 0 && (
        <p className="text-sm text-muted">
          No conference rooms yet. A room is a number (like 800) that several people dial to talk
          together, with an optional PIN.
        </p>
      )}
      {rooms.data && rooms.data.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-sm">
          {rooms.data.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="font-mono">{c.number}</span>
              <span className="font-medium">{c.name}</span>
              <span className="min-w-0 flex-1 truncate text-muted">
                {c.pin ? `PIN ${c.pin}` : 'No PIN'}
                {c.adminPin ? ` · admin PIN ${c.adminPin}` : ''} · up to {c.maxMembers}
                {c.record ? ' · recorded' : ''}
              </span>
              <Button onClick={() => setEditing(c)}>Edit</Button>
              <Button variant="ghost" onClick={() => setDeleting(c)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <RoomForm
          room={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete conference room"
        message={
          <p>
            Delete conference room {deleting?.number} ({deleting?.name})?
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

function RoomForm({
  room,
  onClose,
  onSaved,
}: {
  room: ConferenceDto | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const next = useQuery({
    queryKey: ['next-number', 'conference'],
    queryFn: () => extensionsApi.nextNumber('conference'),
    enabled: !room,
  });
  const [form, setForm] = useState({
    number: room?.number ?? '',
    name: room?.name ?? '',
    pin: room?.pin ?? '',
    adminPin: room?.adminPin ?? '',
    maxMembers: String(room?.maxMembers ?? 20),
    record: room?.record ?? false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const number = form.number || (room ? '' : (next.data ?? ''));

  const save = useMutation({
    mutationFn: (body: ConferenceCreate) =>
      room ? conferencesApi.update(room.id, body) : conferencesApi.create(body),
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });

  function submit() {
    const parsed = ConferenceCreateSchema.safeParse({
      number,
      name: form.name,
      pin: form.pin.trim() || null,
      adminPin: form.adminPin.trim() || null,
      maxMembers: Number(form.maxMembers),
      record: form.record,
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }

  const set = (k: keyof typeof form) => (v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const text = (
    k: 'number' | 'name' | 'pin' | 'adminPin' | 'maxMembers',
    label: string,
    hint?: string,
  ) => (
    <Field label={label} error={errors[k]} hint={hint}>
      {(p) => (
        <input
          {...p}
          className={inputClass}
          inputMode={k === 'name' ? undefined : 'numeric'}
          value={k === 'number' ? number : form[k]}
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
      title={room ? `Conference room ${room.number}` : 'New conference room'}
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
        {text('number', 'Number', 'People dial this to join')}
        {text('name', 'Name')}
        {text('pin', 'PIN', 'Optional, 4 to 10 digits. Callers enter it to join.')}
        {text(
          'adminPin',
          'Admin PIN',
          "Optional, needs a PIN too. Whoever enters it joins as the room's admin.",
        )}
        {text('maxMembers', 'Most people at once')}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.record}
            onChange={(e) => set('record')(e.target.checked)}
          />
          Record (each caller's recording shows in Call history and Recordings)
        </label>
        {save.error && <Alert>{save.error.message}</Alert>}
      </div>
    </Dialog>
  );
}
