// SPDX-License-Identifier: AGPL-3.0-or-later
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useNavigate } from 'react-router';
import { z } from 'zod';
import { ChangePasswordSchema } from '@selfphoneng/shared';
import { authApi } from '../api/client.ts';
import { homeFor, useMe } from '../auth/RequireAuth.tsx';
import { Alert, Button, Field, inputClass } from '../components/ui.tsx';
import { AuthCard } from './LoginPage.tsx';

const FormSchema = ChangePasswordSchema.extend({
  confirm: z.string(),
}).refine((v) => v.newPassword === v.confirm, {
  path: ['confirm'],
  message: 'Passwords do not match',
});

export function ChangePasswordPage() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string>();
  const form = useForm({ resolver: zodResolver(FormSchema) });
  const { errors, isSubmitting } = form.formState;

  if (me.isPending) return null;
  if (me.isError) return <Navigate to="/login" replace />;
  const forced = me.data.mustChangePassword;

  const onSubmit = form.handleSubmit(async ({ currentPassword, newPassword }) => {
    setError(undefined);
    try {
      await authApi.changePassword(currentPassword, newPassword);
      qc.setQueryData(['me'], { ...me.data, mustChangePassword: false });
      nav(homeFor(me.data), { replace: true });
    } catch (e) {
      setError((e as Error).message);
    }
  });

  return (
    <AuthCard title="Change your password">
      {forced && (
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          You signed in with a temporary password. Choose a new one to continue.
        </p>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Current password" error={errors.currentPassword?.message}>
          {(a) => (
            <input
              {...a}
              {...form.register('currentPassword')}
              type="password"
              autoComplete="current-password"
              className={inputClass}
            />
          )}
        </Field>
        <Field
          label="New password"
          error={errors.newPassword?.message}
          hint="At least 10 characters. A few random words work well."
        >
          {(a) => (
            <input
              {...a}
              {...form.register('newPassword')}
              type="password"
              autoComplete="new-password"
              className={inputClass}
            />
          )}
        </Field>
        <Field label="Repeat new password" error={errors.confirm?.message}>
          {(a) => (
            <input
              {...a}
              {...form.register('confirm')}
              type="password"
              autoComplete="new-password"
              className={inputClass}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Change password'}
        </Button>
        {!forced && (
          <Button variant="ghost" onClick={() => nav(-1)}>
            Cancel
          </Button>
        )}
      </form>
    </AuthCard>
  );
}
