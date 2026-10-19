// SPDX-License-Identifier: AGPL-3.0-or-later
// My account (admins): password, and two-step sign-in (TOTP, 08 §2.4) with recovery codes.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { authApi } from '../../api/client.ts';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

export function AccountPage() {
  return (
    <section className="flex max-w-xl flex-col gap-6">
      <h1 className="text-xl font-semibold">My account</h1>
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Password</h2>
        <Link className="text-sm text-sky-700 underline dark:text-sky-400" to="/change-password">
          Change password
        </Link>
      </section>
      <TwoStep />
    </section>
  );
}

function TwoStep() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['totp'], queryFn: authApi.totp });
  const refresh = () => qc.invalidateQueries({ queryKey: ['totp'] });
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const setup = useMutation({ mutationFn: authApi.totpSetup });
  const enable = useMutation({
    mutationFn: () => authApi.totpEnable(setup.data!.secret, code.trim()),
    onSuccess: async (r) => {
      setCodes(r.recoveryCodes);
      setup.reset();
      setCode('');
      await refresh();
    },
  });
  const disable = useMutation({
    mutationFn: () => authApi.totpDisable(password),
    onSuccess: async () => {
      setPassword('');
      setCodes(null);
      await refresh();
    },
  });
  const newCodes = useMutation({
    mutationFn: () => authApi.totpNewCodes(password),
    onSuccess: async (r) => {
      setPassword('');
      setCodes(r.recoveryCodes);
      await refresh();
    },
  });
  const passwordField = (
    <Field label="Your password">
      {(p) => (
        <input
          {...p}
          type="password"
          autoComplete="current-password"
          className={inputClass}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      )}
    </Field>
  );

  return (
    <section aria-labelledby="two-step-h" className="flex flex-col gap-3 text-sm">
      <h2 id="two-step-h" className="font-medium">
        Two-step sign-in
      </h2>
      <p className="text-zinc-600 dark:text-zinc-400">
        Besides your password, signing in asks for a code from an authenticator app on your phone
        (any app that does TOTP, such as Aegis, 2FAS, Google or Microsoft Authenticator).
      </p>
      {status.isError && <Alert>{status.error.message}</Alert>}
      {codes && (
        <div role="note" className="rounded-md bg-amber-50 p-3 dark:bg-amber-950">
          <p className="mb-2 font-medium">
            Recovery codes: save them now, they won't be shown again
          </p>
          <p className="mb-2">
            Each one signs you in once if you lose your phone. Keep them somewhere safe, away from
            the phone.
          </p>
          <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-1 font-mono">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {status.data && !status.data.enabled && !setup.data && (
        <Button className="self-start" onClick={() => setup.mutate()} disabled={setup.isPending}>
          Turn on two-step sign-in
        </Button>
      )}
      {setup.data && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            enable.mutate();
          }}
        >
          <p>1. Scan this with your authenticator app:</p>
          <img
            src={setup.data.qr}
            alt="Authenticator setup QR code"
            width={240}
            height={240}
            className="rounded bg-white"
          />
          <p className="text-xs text-zinc-500">
            Or type this key: <span className="font-mono break-all">{setup.data.secret}</span>
          </p>
          <Field label="2. Enter the 6-digit code it shows">
            {(p) => (
              <input
                {...p}
                inputMode="numeric"
                autoComplete="one-time-code"
                className={`${inputClass} max-w-40`}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={enable.isPending}>
              Turn on
            </Button>
            <Button onClick={() => setup.reset()}>Cancel</Button>
          </div>
          {enable.error && <Alert>{enable.error.message}</Alert>}
        </form>
      )}
      {status.data?.enabled && (
        <div className="flex flex-col gap-3">
          <p>
            <strong>On.</strong> {status.data.recoveryCodesLeft} recovery code
            {status.data.recoveryCodesLeft === 1 ? '' : 's'} left.
          </p>
          {passwordField}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => newCodes.mutate()} disabled={!password || newCodes.isPending}>
              New recovery codes
            </Button>
            <Button
              variant="danger"
              onClick={() => disable.mutate()}
              disabled={!password || disable.isPending}
            >
              Turn off
            </Button>
          </div>
          {(disable.error ?? newCodes.error) && (
            <Alert>{(disable.error ?? newCodes.error)!.message}</Alert>
          )}
        </div>
      )}
    </section>
  );
}
