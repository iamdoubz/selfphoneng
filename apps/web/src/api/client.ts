// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed fetch wrappers (05 §1). Every request sends X-Requested-With (CSRF, 04 §2.2).
import type { AuthUser, ListResponse, UserCreate, UserDto, UserUpdate } from '@selfphoneng/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'selfphoneng',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'internal', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

export const authApi = {
  me: () => api<{ user: AuthUser }>('GET', '/api/auth/me').then((r) => r.user),
  login: (email: string, password: string) =>
    api<{ user: AuthUser }>('POST', '/api/auth/login', { email, password }).then((r) => r.user),
  logout: () => api<{ ok: true }>('POST', '/api/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api<{ ok: true }>('POST', '/api/auth/change-password', { currentPassword, newPassword }),
};

export const usersApi = {
  list: () => api<ListResponse<UserDto>>('GET', '/api/users').then((r) => r.items),
  create: (u: UserCreate) =>
    api<{ user: UserDto; temporaryPassword: string }>('POST', '/api/users', u),
  update: (id: string, u: UserUpdate) => api<UserDto>('PATCH', `/api/users/${id}`, u),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/users/${id}`),
  resetPassword: (id: string) =>
    api<{ temporaryPassword: string }>('POST', `/api/users/${id}/reset-password`),
};
