// SPDX-License-Identifier: AGPL-3.0-or-later
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { APP_NAME, LoginFields } from '@selfphoneng/shared';
import { ApiError, authApi } from '../api/client.ts';
import { homeFor } from '../auth/RequireAuth.tsx';
import { Alert, Button, Field, inputClass } from '../components/ui.tsx';

export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <img src="/logo-512.png" alt={APP_NAME} className="mx-auto mb-4 size-32 rounded-xl" />
        <h1 className="mb-5 text-xl font-semibold">{title}</h1>
        {children}
      </div>
      <Link to="/about" className="mt-3 text-xs text-zinc-500 hover:underline">
        About SelfPhoneNG · source code
      </Link>
    </main>
  );
}

export function LoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const [error, setError] = useState<string>();
  // Two-step sign-in: shown once the server says the password was right and a code is needed.
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState('');
  const form = useForm({ resolver: zodResolver(LoginFields.omit({ totp: true })) });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ login, password }) => {
    setError(undefined);
    try {
      const user = await authApi.login(login, password, needCode ? code : undefined);
      qc.setQueryData(['me'], user);
      const next = params.get('next');
      // Only same-site paths: never redirect to another origin.
      nav(next?.startsWith('/') && !next.startsWith('//') ? next : homeFor(user), {
        replace: true,
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'totp_required') {
        setNeedCode(true);
        return;
      }
      setError((e as Error).message);
    }
  });

  return (
    <AuthCard title="Sign in">
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Email" error={errors.login?.message}>
          {(a) => (
            <input
              {...a}
              {...form.register('login')}
              type="email"
              autoComplete="username"
              className={inputClass}
            />
          )}
        </Field>
        <Field label="Password" error={errors.password?.message}>
          {(a) => (
            <input
              {...a}
              {...form.register('password')}
              type="password"
              autoComplete="current-password"
              className={inputClass}
            />
          )}
        </Field>
        {needCode && (
          <Field
            label="Authentication code"
            hint="From your authenticator app, or one of your recovery codes"
          >
            {(a) => (
              <input
                {...a}
                autoFocus
                autoComplete="one-time-code"
                className={inputClass}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
        )}
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthCard>
  );
}
