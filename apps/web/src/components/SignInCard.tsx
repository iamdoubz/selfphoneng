// SPDX-License-Identifier: AGPL-3.0-or-later
// My sign-in ways (12 §5): the password, and connecting or disconnecting an OpenID account.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router';
import { authApi } from '../api/client.ts';
import { useMe } from '../auth/RequireAuth.tsx';
import { Alert, Button } from './ui.tsx';

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
          <Link className="text-sky-700 underline dark:text-sky-400" to="/change-password">
            Change password
          </Link>
        ) : (
          <p className="text-zinc-500">
            You have no password here. An admin can give you one with Reset password.
          </p>
        )}
      </div>
      {ways.ldap && (
        <p className="text-sm">
          Your company directory account is connected: its password works here too.
        </p>
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
              <p className="text-zinc-500">
                Connect your {oidc.label} account to sign in with it as well.
              </p>
              <div>
                {/* A full page load: the browser goes to the provider and comes back. */}
                <a
                  className="inline-block rounded-md border border-zinc-300 px-3 py-1.5 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  href={`/api/auth/oidc/start?connect=1&next=${encodeURIComponent(loc.pathname)}`}
                >
                  Connect {oidc.label}
                </a>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
