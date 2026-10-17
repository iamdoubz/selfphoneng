// SPDX-License-Identifier: AGPL-3.0-or-later
// Users & Extensions (05 §2). M1: the General tab only; extension tabs arrive in M2.
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { RoleSchema, type UserDto } from '@selfphoneng/shared';
import { usersApi } from '../../api/client.ts';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

const FormSchema = z.object({
  displayName: z.string().trim().min(1, 'Required').max(100),
  email: z.email('Enter a valid email'),
  role: RoleSchema,
  isActive: z.boolean(),
});
type FormValues = z.infer<typeof FormSchema>;

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
  if (users.length === 0) return <p className="text-sm text-zinc-500">No users yet.</p>;
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
                <p className="font-medium">{u.displayName}</p>
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

function UserDrawer({
  user,
  isSelf,
  onClose,
  onSaved,
  onResetPassword,
}: {
  user: UserDto | null;
  isSelf: boolean;
  onClose: () => void;
  onSaved: (created?: { email: string; password: string }) => void;
  onResetPassword: (u: UserDto) => void;
}) {
  const [error, setError] = useState<string>();
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: user
      ? {
          displayName: user.displayName,
          email: user.email,
          role: user.role,
          isActive: user.isActive,
        }
      : { displayName: '', email: '', role: 'user', isActive: true },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(undefined);
    try {
      if (user) {
        await usersApi.update(user.id, v);
        onSaved();
      } else {
        const r = await usersApi.create({
          displayName: v.displayName,
          email: v.email,
          role: v.role,
        });
        onSaved({ email: r.user.email, password: r.temporaryPassword });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  });

  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={user ? `Edit ${user.displayName}` : 'New user'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="user-form" disabled={isSubmitting}>
            {user ? 'Save' : 'Create user'}
          </Button>
        </>
      }
    >
      {/* Tabs (05 §2): General now; Phone, Voicemail, Calling, Emergency, Credentials and
          Forwarding arrive with extensions in M2. */}
      <div role="tablist" className="mb-4 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        <span
          role="tab"
          aria-selected="true"
          className="border-b-2 border-sky-600 px-3 py-1.5 text-sm font-medium"
        >
          General
        </span>
      </div>
      <form id="user-form" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Name" error={errors.displayName?.message}>
          {(a) => <input {...a} {...form.register('displayName')} className={inputClass} />}
        </Field>
        <Field label="Email" error={errors.email?.message}>
          {(a) => <input {...a} {...form.register('email')} type="email" className={inputClass} />}
        </Field>
        <Field
          label="Role"
          error={errors.role?.message}
          hint={
            isSelf ? 'You cannot remove your own admin role if you are the last admin.' : undefined
          }
        >
          {(a) => (
            <select {...a} {...form.register('role')} className={inputClass}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          )}
        </Field>
        {user && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              {...form.register('isActive')}
              className="size-4"
              disabled={isSelf}
            />
            Active (inactive users cannot sign in)
          </label>
        )}
        <p className="text-xs text-zinc-500">Extension number and phone settings: coming in M2.</p>
        {user && (
          <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <Button onClick={() => onResetPassword(user)}>Reset password</Button>
            <p className="mt-1 text-xs text-zinc-500">
              Creates a new temporary password and signs them out everywhere.
            </p>
          </div>
        )}
      </form>
    </Dialog>
  );
}
