// SPDX-License-Identifier: AGPL-3.0-or-later
// Paging (05 §2, 03 §6.11): number, name, members, duplex. Dialing the number makes the members'
// desk phones answer by themselves and play what the caller says.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  PagingGroupCreateSchema,
  type PagingGroupCreate,
  type PagingGroupDto,
} from '@selfphoneng/shared';
import { extensionsApi, pagingApi } from '../../api/client.ts';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

export function PagingPage() {
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ['paging-groups'], queryFn: pagingApi.list });
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const [editing, setEditing] = useState<PagingGroupDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PagingGroupDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['paging-groups'] });
  const remove = useMutation({
    mutationFn: (id: string) => pagingApi.remove(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });
  const nameOf = (id: string) => exts.data?.find((x) => x.id === id)?.name ?? '?';

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Paging</h1>
        <Button variant="primary" onClick={() => setEditing('new')}>
          Add paging group
        </Button>
      </div>
      {groups.isError && <Alert>{groups.error.message}</Alert>}
      {groups.data?.length === 0 && (
        <p className="text-sm text-muted">
          No paging groups yet. Dialing a paging group's number (like 850) makes its desk phones
          answer by themselves, so everyone near them hears you. To talk to one desk phone this way,
          dial *80 and its extension (like *80101).
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
                {g.duplex ? 'Two-way' : 'One-way'}:{' '}
                {g.memberIds.map(nameOf).join(', ') || 'nobody yet'}
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
        <PagingForm
          group={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete paging group"
        message={
          <p>
            Delete paging group {deleting?.number} ({deleting?.name})?
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

function PagingForm({
  group,
  onClose,
  onSaved,
}: {
  group: PagingGroupDto | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const next = useQuery({
    queryKey: ['next-number', 'paging'],
    queryFn: () => extensionsApi.nextNumber('paging'),
    enabled: !group,
  });
  const [form, setForm] = useState({
    number: group?.number ?? '',
    name: group?.name ?? '',
    duplex: group?.duplex ?? false,
  });
  const [members, setMembers] = useState<string[]>(group?.memberIds ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const number = form.number || (group ? '' : (next.data ?? ''));

  const save = useMutation({
    mutationFn: (body: PagingGroupCreate) =>
      group ? pagingApi.update(group.id, body) : pagingApi.create(body),
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });

  function submit() {
    const parsed = PagingGroupCreateSchema.safeParse({ ...form, number, memberIds: members });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }

  const text = (k: 'number' | 'name', label: string, hint?: string) => (
    <Field label={label} error={errors[k]} hint={hint}>
      {(p) => (
        <input
          {...p}
          className={inputClass}
          inputMode={k === 'number' ? 'numeric' : undefined}
          value={k === 'number' ? number : form[k]}
          onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
        />
      )}
    </Field>
  );

  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={group ? `Paging group ${group.number}` : 'New paging group'}
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
        {text('number', 'Number', 'Dial this to page the group')}
        {text('name', 'Name')}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.duplex}
            onChange={(e) => setForm((f) => ({ ...f, duplex: e.target.checked }))}
          />
          Two-way (the people paged can answer back)
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">Members</legend>
          {errors.memberIds && <Alert>{errors.memberIds}</Alert>}
          {exts.data?.map((x) => (
            <label key={x.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={members.includes(x.id)}
                onChange={(e) =>
                  setMembers((ms) =>
                    e.target.checked ? [...ms, x.id] : ms.filter((m) => m !== x.id),
                  )
                }
              />
              {x.number} {x.name}
            </label>
          ))}
          <p className="text-xs text-muted">
            Only desk phones are paged, not the browser phone, and phones already on a call are
            skipped. Most Yealink, Grandstream, Polycom and Snom phones answer pages by themselves.
          </p>
        </fieldset>
        {save.error && <Alert>{save.error.message}</Alert>}
      </div>
    </Dialog>
  );
}
