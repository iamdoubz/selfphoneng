// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed fetch wrappers (05 §1). Every request sends X-Requested-With (CSRF, 04 §2.2).
import type {
  AuthUser,
  DidCreate,
  DidDto,
  DidUpdate,
  ExtensionCreate,
  ExtensionDto,
  ExtensionUpdate,
  GreetingKind,
  ListResponse,
  NumberKind,
  OutboundRouteCreate,
  OutboundRouteDto,
  OutboundRouteUpdate,
  RouteTestResult,
  SettingsDto,
  SipCredentials,
  TrunkCreate,
  TrunkDto,
  TrunkTestResult,
  TrunkUpdate,
  UserCreate,
  UserDto,
  UserUpdate,
  VoicemailDto,
  Warning,
} from '@selfphoneng/shared';

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

export const extensionsApi = {
  list: () => api<ListResponse<ExtensionDto>>('GET', '/api/extensions').then((r) => r.items),
  get: (id: string) => api<ExtensionDto>('GET', `/api/extensions/${id}`),
  create: (e: ExtensionCreate) => api<ExtensionDto>('POST', '/api/extensions', e),
  update: (id: string, e: ExtensionUpdate) =>
    api<ExtensionDto>('PATCH', `/api/extensions/${id}`, e),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/extensions/${id}`),
  credentials: (id: string) => api<SipCredentials>('GET', `/api/extensions/${id}/sip-credentials`),
  regenerateSipPassword: (id: string) =>
    api<{ ok: true }>('POST', `/api/extensions/${id}/regenerate-sip-password`),
  nextNumber: (kind: NumberKind) =>
    api<{ number: string | null }>('GET', `/api/numbering/next?kind=${kind}`).then((r) => r.number),
};

export const trunksApi = {
  list: () => api<ListResponse<TrunkDto>>('GET', '/api/trunks').then((r) => r.items),
  create: (t: TrunkCreate) => api<TrunkDto>('POST', '/api/trunks', t),
  update: (id: string, t: TrunkUpdate) => api<TrunkDto>('PATCH', `/api/trunks/${id}`, t),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/trunks/${id}`),
  test: (id: string) => api<TrunkTestResult>('POST', `/api/trunks/${id}/test`),
};

export const didsApi = {
  list: () => api<ListResponse<DidDto>>('GET', '/api/dids').then((r) => r.items),
  create: (d: DidCreate) => api<DidDto>('POST', '/api/dids', d),
  update: (id: string, d: DidUpdate) => api<DidDto>('PATCH', `/api/dids/${id}`, d),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/dids/${id}`),
};

export const routesApi = {
  list: () =>
    api<ListResponse<OutboundRouteDto>>('GET', '/api/outbound-routes').then((r) => r.items),
  create: (r: OutboundRouteCreate) => api<OutboundRouteDto>('POST', '/api/outbound-routes', r),
  update: (id: string, r: OutboundRouteUpdate) =>
    api<OutboundRouteDto>('PATCH', `/api/outbound-routes/${id}`, r),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/outbound-routes/${id}`),
  reorder: (ids: string[]) => api<{ ok: true }>('POST', '/api/outbound-routes/reorder', { ids }),
  test: (extensionId: string, number: string) =>
    api<RouteTestResult>('POST', '/api/outbound-routes/test', { extensionId, number }),
};

export const settingsApi = {
  get: () => api<SettingsDto>('GET', '/api/settings'),
  patch: (s: Record<string, unknown>) => api<SettingsDto>('PATCH', '/api/settings', s),
  testEmail: (to: string) => api<{ ok: true }>('POST', '/api/settings/smtp/test', { to }),
  testEmergency: () =>
    api<{ notified: { kind: string; to: string; ok: boolean; error?: string }[] }>(
      'POST',
      '/api/settings/emergency/test',
    ),
  warnings: () => api<{ items: Warning[] }>('GET', '/api/system/warnings').then((r) => r.items),
};

export const systemApi = {
  status: () =>
    api<{ ami: { connected: boolean }; restartRequired: boolean; lanIps: string[] }>(
      'GET',
      '/api/system/status',
    ),
  restartAsterisk: (now: boolean) =>
    api<{ ok: true }>('POST', `/api/system/asterisk/restart?now=${now}`),
  detectPublicIp: () =>
    api<{ ip: string }>('POST', '/api/settings/network/detect-public-ip').then((r) => r.ip),
  setupStatus: () => api<{ completed: boolean }>('GET', '/api/setup/status'),
  completeSetup: () => api<{ ok: true }>('POST', '/api/setup/complete'),
};

export const meApi = {
  voicemail: () => api<ListResponse<VoicemailDto>>('GET', '/api/me/voicemail').then((r) => r.items),
  audioUrl: (id: string, download = false) =>
    `/api/me/voicemail/${id}/audio${download ? '?download=1' : ''}`,
  moveVoicemail: (id: string, folder: 'INBOX' | 'Old') =>
    api<VoicemailDto>('PATCH', `/api/me/voicemail/${id}`, { folder }),
  deleteVoicemail: (id: string) => api<{ ok: true }>('DELETE', `/api/me/voicemail/${id}`),
  greetings: () => api<Record<GreetingKind, boolean>>('GET', '/api/me/greetings'),
  greetingUrl: (kind: GreetingKind) => `/api/me/greetings/${kind}/audio`,
  /** The raw recording or file is the body; the server converts it with ffmpeg. */
  putGreeting: async (kind: GreetingKind, audio: Blob) => {
    const res = await fetch(`/api/me/greetings/${kind}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'selfphoneng',
        'Content-Type': audio.type || 'application/octet-stream',
      },
      body: audio,
    });
    if (!res.ok) {
      const e = (await res.json().catch(() => null))?.error ?? {};
      throw new ApiError(res.status, e.code ?? 'internal', e.message ?? res.statusText, e.details);
    }
  },
  deleteGreeting: (kind: GreetingKind) => api<{ ok: true }>('DELETE', `/api/me/greetings/${kind}`),
};
