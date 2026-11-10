// SPDX-License-Identifier: AGPL-3.0-or-later
// My sign-in ways (12 §5): the password, connecting or disconnecting an OpenID account, and
// connecting a directory account, and passkeys (15).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router';
import { authApi } from '../api/client.ts';
import { createPasskey, passkeysSupported } from '../auth/passkey.ts';
import { useMe } from '../auth/RequireAuth.tsx';
import { Alert, Button, Field, inputClass } from './ui.tsx';

/** What `?sso_error=` means (12 §3.2), for the login page and here. */
export function ssoErrorText(code: string, label: string): string {
  return (
    {
      expired: 'Sign-in took too long. Try again.',
      denied: 'Sign-in was cancelled.',
      not_allowed: `Your ${label} account isn't allowed to use the phone system. Ask your admin.`,
      not_connected: `This ${label} account isn't connected to a phone system account. Sign in with your password and connect it in your settings, or ask your admin.`,
      taken: `This ${label} account is already connected to another user.`,
      disabled: 'Your account is disabled.',
      too_many: 'Too many failed sign-ins. Wait 15 minutes and try again.',
    }[code] ?? `${label} sign-in didn't work. Your admin can see why in the log.`
  );
}

export const useAuthMethods = () =>
  useQuery({ queryKey: ['auth-methods'], queryFn: authApi.methods, staleTime: 60_000 });

export function SignInCard() {
  const me = useMe();
  const methods = useAuthMethods();
  const qc = useQueryClient();
  const loc = useLocation();
  const [params] = useSearchParams();
  const disconnect = useMutation({
    mutationFn: authApi.disconnectOidc,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const connect = useMutation({
    mutationFn: () => authApi.connectOidc(loc.pathname),
    onSuccess: (r) => window.location.assign(r.url),
  });
  const ways = me.data?.signIn;
  const oidc = methods.data?.oidc;
  if (!ways) return null;
  const error = params.get('sso_error');
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Sign-in</h2>
      {params.get('sso') === 'connected' && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Connected. You can now sign in with {oidc?.label ?? 'OpenID'}.
        </p>
      )}
      {error && <Alert>{ssoErrorText(error, oidc?.label ?? 'OpenID')}</Alert>}
      <div className="flex flex-col gap-1 text-sm">
        <h3 className="font-medium">Password</h3>
        {ways.password ? (
          <Link className="text-link underline" to="/change-password">
            Change password
          </Link>
        ) : (
          <p className="text-muted">
            You have no password here. An admin can give you one with Reset password.
          </p>
        )}
      </div>
      {/* Adding one asks for the password again, so it needs one (15 §1). */}
      {ways.password && passkeysSupported() && <Passkeys />}
      {ways.ldap ? (
        <p className="text-sm">
          Your company directory account is connected: its password works here too. Only an admin
          can disconnect it.
        </p>
      ) : (
        methods.data?.ldap && <DirectoryConnect />
      )}
      {oidc && (
        <div className="flex flex-col gap-2 text-sm">
          <h3 className="font-medium">{oidc.label}</h3>
          {ways.oidc ? (
            <>
              <p>
                Connected{ways.oidc.email ? ` as ${ways.oidc.email}` : ''}. You can sign in with{' '}
                {oidc.label}
                {ways.password ? ' or your password' : ''}.
              </p>
              <div>
                <Button onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                  Disconnect {oidc.label}
                </Button>
              </div>
              {disconnect.error && <Alert>{disconnect.error.message}</Alert>}
            </>
          ) : (
            <>
              <p className="text-muted">
                Connect your {oidc.label} account to sign in with it as well.
              </p>
              <div>
                {/* The browser goes to the provider and comes back (a POST first: 12 §3.3). */}
                <Button
                  onClick={() => connect.mutate()}
                  disabled={connect.isPending || connect.isSuccess}
                >
                  Connect {oidc.label}
                </Button>
              </div>
              {connect.error && <Alert>{connect.error.message}</Alert>}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Connect my directory account (12 §4.3): its username and password, checked by the directory. */
function DirectoryConnect() {
  const qc = useQueryClient();
  const [v, setV] = useState({ login: '', password: '' });
  const connect = useMutation({
    mutationFn: () => authApi.connectLdap(v.login, v.password),
    onSuccess: () => {
      setV({ login: '', password: '' });
      return qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <form
      className="flex flex-col gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        connect.mutate();
      }}
    >
      <h3 className="font-medium">Company directory</h3>
      <p className="text-muted">
        Connect your directory account to sign in with its password as well.
      </p>
      <Field label="Directory username or email">
        {(a) => (
          <input
            {...a}
            className={inputClass}
            autoComplete="username"
            value={v.login}
            onChange={(e) => setV({ ...v, login: e.target.value })}
          />
        )}
      </Field>
      <Field label="Directory password">
        {(a) => (
          <input
            {...a}
            type="password"
            className={inputClass}
            autoComplete="current-password"
            value={v.password}
            onChange={(e) => setV({ ...v, password: e.target.value })}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={connect.isPending || !v.login || !v.password}>
          Connect directory account
        </Button>
      </div>
      {connect.error && <Alert>{connect.error.message}</Alert>}
    </form>
  );
}

/** My passkeys (15): the list, Remove, and adding one on this device. */
function Passkeys() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['passkeys'], queryFn: authApi.passkeys });
  const refresh = () => qc.invalidateQueries({ queryKey: ['passkeys'] });
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState({ name: '', password: '' });
  const add = useMutation({
    mutationFn: async () =>
      authApi.passkeyAdd({ ...(await createPasskey(await authApi.passkeyCreateOptions())), ...v }),
    onSuccess: () => {
      setV({ name: '', password: '' });
      setAdding(false);
      return refresh();
    },
  });
  const remove = useMutation({ mutationFn: authApi.passkeyRemove, onSuccess: refresh });
  return (
    <div className="flex flex-col gap-2 text-sm">
      <h3 className="font-medium">Passkeys</h3>
      <p className="text-muted">
        Sign in with this device’s fingerprint, face or PIN instead of your password and code. An
        admin’s Reset password removes your passkeys.
      </p>
      {list.isError && <Alert>{list.error.message}</Alert>}
      {list.data && list.data.length > 0 && (
        <ul aria-label="Your passkeys" className="flex flex-col gap-1">
          {list.data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {p.name}{' '}
                <span className="text-muted">
                  · added {new Date(p.createdAt).toLocaleDateString()}
                  {p.lastUsedAt
                    ? `, last used ${new Date(p.lastUsedAt).toLocaleDateString()}`
                    : ', not used yet'}
                </span>
              </span>
              <Button
                aria-label={`Remove the passkey ${p.name}`}
                onClick={() => remove.mutate(p.id)}
                disabled={remove.isPending}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {remove.error && <Alert>{remove.error.message}</Alert>}
      {adding ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field label="Name for this passkey" hint="For example: Work laptop">
            {(a) => (
              <input
                {...a}
                className={inputClass}
                maxLength={60}
                value={v.name}
                onChange={(e) => setV({ ...v, name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Your password">
            {(a) => (
              <input
                {...a}
                type="password"
                autoComplete="current-password"
                className={inputClass}
                value={v.password}
                onChange={(e) => setV({ ...v, password: e.target.value })}
              />
            )}
          </Field>
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={add.isPending || !v.name.trim() || !v.password}
            >
              {add.isPending ? 'Waiting for your device…' : 'Add passkey'}
            </Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </div>
          {add.error && <Alert>{add.error.message}</Alert>}
        </form>
      ) : (
        <div>
          <Button onClick={() => setAdding(true)}>Add a passkey</Button>
        </div>
      )}
    </div>
  );
}
