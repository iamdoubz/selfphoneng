// SPDX-License-Identifier: AGPL-3.0-or-later
// Users & Extensions (05 §2).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { UserDto } from '@selfphoneng/shared';
import { usersApi } from '../../api/client.ts';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { Alert, Button } from '../../components/ui.tsx';
import { UserDrawer } from './UserDrawer.tsx';
import { StatusDot } from '../../components/StatusDot.tsx';
import { useLive } from '../../live/store.ts';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never');

export function UsersPage({ currentUserId }: { currentUserId: string }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: usersApi.list });
  const [editing, setEditing] = useState<UserDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<UserDto | null>(null);
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(
    null,
  );
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });

  const remove = useMutation({
    mutationFn: (id: string) => usersApi.remove(id),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });
  const reset = useMutation({
    mutationFn: (u: UserDto) => usersApi.resetPassword(u.id),
    onSuccess: (r, u) => setTempPassword({ email: u.email, password: r.temporaryPassword }),
  });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Users & Extensions</h1>
        <Button variant="primary" onClick={() => setEditing('new')}>
          New user
        </Button>
      </div>

      {users.isError && <Alert>{users.error.message}</Alert>}
      {users.isPending && <p className="text-sm text-zinc-500">Loading…</p>}
      {users.data && (
        <UsersTable
          users={users.data}
          onEdit={setEditing}
          onDelete={(u) => {
            remove.reset();
            setDeleting(u);
          }}
        />
      )}

      {editing && (
        <UserDrawer
          user={editing === 'new' ? null : editing}
          isSelf={editing !== 'new' && editing.id === currentUserId}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null);
            void refresh();
            if (created) setTempPassword(created);
          }}
          onResetPassword={(u) => reset.mutate(u)}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete user"
        message={
          <p>
            Delete <strong>{deleting?.displayName}</strong> ({deleting?.email})? They will be signed
            out and can no longer log in.
            {deleting?.extension &&
              ` Extension ${deleting.extension.number} stays, without a user.`}
          </p>
        }
        confirmLabel="Delete"
        busy={remove.isPending}
        error={remove.error?.message}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />

      <Dialog
        open={tempPassword !== null}
        onClose={() => setTempPassword(null)}
        title="Temporary password"
        footer={
          <Button variant="primary" onClick={() => setTempPassword(null)}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>
            Give this password to <strong>{tempPassword?.email}</strong>. It is shown only once, and
            they must change it when they first sign in.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md bg-zinc-100 px-3 py-2 font-mono text-base dark:bg-zinc-800">
              {tempPassword?.password}
            </code>
            <Button
              onClick={() => void navigator.clipboard?.writeText(tempPassword?.password ?? '')}
            >
              Copy
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}

function UsersTable({
  users,
  onEdit,
  onDelete,
}: {
  users: UserDto[];
  onEdit: (u: UserDto) => void;
  onDelete: (u: UserDto) => void;
}) {
  const live = useLive((s) => s.extensions);
  if (users.length === 0) return <p className="text-sm text-zinc-500">No users yet.</p>;
  const ext = (u: UserDto) =>
    u.extension ? (
      <span className="inline-flex items-center gap-1.5 font-mono">
        <StatusDot ext={live[u.extension.number]} />
        {u.extension.number}
      </span>
    ) : (
      '–'
    );
  const badge = (u: UserDto) => (
    <span className="flex flex-wrap gap-1">
      {u.role === 'admin' && (
        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-200">
          admin
        </span>
      )}
      {!u.isActive && (
        <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs dark:bg-zinc-700">inactive</span>
      )}
    </span>
  );
  const actions = (u: UserDto) => (
    <span className="flex gap-1">
      <Button variant="ghost" onClick={() => onEdit(u)} aria-label={`Edit ${u.displayName}`}>
        Edit
      </Button>
      <Button variant="ghost" onClick={() => onDelete(u)} aria-label={`Delete ${u.displayName}`}>
        Delete
      </Button>
    </span>
  );
  return (
    <>
      {/* Stacked cards on small screens (05 §1). */}
      <ul className="flex flex-col gap-2 md:hidden">
        {users.map((u) => (
          <li key={u.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">
                  {u.displayName}
                  {u.extension && <span className="ml-2 text-sm text-zinc-500">{ext(u)}</span>}
                </p>
                <p className="truncate text-sm text-zinc-500">{u.email}</p>
              </div>
              {badge(u)}
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
              <span>Last login: {fmtDate(u.lastLoginAt)}</span>
              {actions(u)}
            </div>
          </li>
        ))}
      </ul>
      <table className="hidden w-full text-left text-sm md:table">
        <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
          <tr>
            <th className="py-2 font-medium">Ext.</th>
            <th className="py-2 font-medium">Name</th>
            <th className="py-2 font-medium">Email</th>
            <th className="py-2 font-medium">Role</th>
            <th className="py-2 font-medium">Last login</th>
            <th className="py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-zinc-100 dark:border-zinc-800/60">
              <td className="py-2">{ext(u)}</td>
              <td className="py-2 font-medium">{u.displayName}</td>
              <td className="py-2">{u.email}</td>
              <td className="py-2">{badge(u)}</td>
              <td className="py-2 text-zinc-500">{fmtDate(u.lastLoginAt)}</td>
              <td className="py-2 text-right">{actions(u)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
