// SPDX-License-Identifier: AGPL-3.0-or-later
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { APP_NAME, LoginFields } from '@selfphoneng/shared';
import { ApiError, authApi } from '../api/client.ts';
import { homeFor } from '../auth/RequireAuth.tsx';
import { ssoErrorText, useAuthMethods } from '../components/SignInCard.tsx';
import { Alert, Button, Field, inputClass } from '../components/ui.tsx';

export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm">
        <img src="/logo-512.png" alt={APP_NAME} className="mx-auto mb-4 size-32 rounded-xl" />
        <h1 className="mb-5 text-xl font-semibold">{title}</h1>
        {children}
      </div>
      <Link to="/about" className="mt-3 text-xs text-muted hover:underline">
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
  // 12 §1.1: the OpenID button, the password form, or both. OpenID only: the form is for admins.
  const methods = useAuthMethods();
  const oidc = methods.data?.oidc;
  const [adminForm, setAdminForm] = useState(false);
  const showForm = methods.data?.mode !== 'oidc' || adminForm;
  const ssoError = params.get('sso_error');
  const next = params.get('next');

  const onSubmit = form.handleSubmit(async ({ login, password }) => {
    setError(undefined);
    try {
      const user = await authApi.login(login, password, needCode ? code : undefined);
      qc.setQueryData(['me'], user);
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
      {ssoError && (
        <div className="mb-4">
          <Alert>{ssoErrorText(ssoError, oidc?.label ?? 'OpenID')}</Alert>
        </div>
      )}
      {oidc && (
        <div className="mb-4 flex flex-col gap-3">
          {/* A full page load: the browser goes to the provider and comes back signed in. */}
          <a
            href={`/api/auth/oidc/start${next ? `?next=${encodeURIComponent(next)}` : ''}`}
            className="rounded-md bg-primary px-4 py-2 text-center text-sm font-medium text-white hover:bg-primary-hover"
          >
            Sign in with {oidc.label}
          </a>
          {showForm && (
            <p className="text-center text-xs text-muted" aria-hidden>
              or with your password
            </p>
          )}
        </div>
      )}
      {!showForm && (
        <button
          type="button"
          className="w-full text-center text-xs text-muted hover:underline"
          onClick={() => setAdminForm(true)}
        >
          Admin sign-in
        </button>
      )}
      <form
        onSubmit={onSubmit}
        className={`flex flex-col gap-4 ${showForm ? '' : 'hidden'}`}
        noValidate
      >
        {error && <Alert>{error}</Alert>}
        <Field
          label={methods.data?.ldap ? 'Email or username' : 'Email'}
          error={errors.login?.message}
        >
          {(a) => (
            <input
              {...a}
              {...form.register('login')}
              type={methods.data?.ldap ? 'text' : 'email'}
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
