// SPDX-License-Identifier: AGPL-3.0-or-later
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { AuthUser } from '@selfphoneng/shared';
import { ApiError, authApi } from '../api/client.ts';

export const meQuery = {
  queryKey: ['me'],
  queryFn: authApi.me,
  retry: (n: number, e: Error) => !(e instanceof ApiError && e.status === 401) && n < 2,
  staleTime: 60_000,
};

export function useMe() {
  return useQuery(meQuery);
}

/** Gate for signed-in pages: login first, then a forced password change, then the role check. */
export function RequireAuth({
  role,
  children,
}: {
  role?: AuthUser['role'];
  children: (user: AuthUser) => ReactNode;
}) {
  const me = useMe();
  const loc = useLocation();
  if (me.isPending) return <p className="p-6 text-sm text-zinc-500">Loading…</p>;
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401)
      return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
    return <p className="p-6 text-sm text-red-600">Could not reach the server.</p>;
  }
  const user = me.data;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return <>{children(user)}</>;
}

export const homeFor = (user: AuthUser) => (user.role === 'admin' ? '/admin' : '/me');
