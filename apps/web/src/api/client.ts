// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed fetch wrappers (05 §1). Every request sends X-Requested-With (CSRF, 04 §2.2).
import type {
  AnnouncementCreate,
  AnnouncementDto,
  AnnouncementUpdate,
  BlockedCreate,
  BlockedDto,
  CallDetailDto,
  CallDto,
  CallFilter,
  MyCallDto,
  RecordingDto,
  AuthUser,
  DidCreate,
  DidDto,
  DidUpdate,
  ExtensionCreate,
  ExtensionDto,
  ExtensionUpdate,
  GreetingKind,
  HolidayDto,
  HolidayInput,
  IvrCreate,
  IvrDto,
  IvrUpdate,
  ListResponse,
  MeDto,
  MeUpdate,
  NumberKind,
  OutboundRouteCreate,
  OutboundRouteDto,
  OutboundRouteUpdate,
  ConferenceCreate,
  ConferenceDto,
  ConferenceUpdate,
  DeviceCreate,
  DeviceDto,
  DeviceUpdate,
  PagingGroupCreate,
  PagingGroupDto,
  PagingGroupUpdate,
  QueueCreate,
  QueueDto,
  QueueStats,
  QueueUpdate,
  RingGroupCreate,
  RingGroupDto,
  RingGroupUpdate,
  RouteTestResult,
  SettingsDto,
  SipCredentials,
  SoundDto,
  SoftphoneQr,
  MohClassDto,
  TotpSetup,
  TotpStatus,
  VoipmsDidDto,
  TimeConditionCreate,
  TimeConditionDto,
  TimeConditionUpdate,
  OverrideState,
  TrunkCreate,
  TrunkDto,
  TrunkTestResult,
  TrunkUpdate,
  UserCreate,
  UserDto,
  UserUpdate,
  VoicemailDto,
  WebRtcCreds,
  TlsCert,
  BackupDto,
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

/** Audio uploads: the file itself is the body (no multipart), with its own Content-Type. */
async function upload<T>(method: string, url: string, body: Blob): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'selfphoneng',
      'Content-Type': body.type || 'application/octet-stream',
    },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'internal', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

export const authApi = {
  me: () => api<{ user: AuthUser }>('GET', '/api/auth/me').then((r) => r.user),
  login: (email: string, password: string, totp?: string) =>
    api<{ user: AuthUser }>('POST', '/api/auth/login', {
      email,
      password,
      ...(totp ? { totp } : {}),
    }).then((r) => r.user),
  totp: () => api<TotpStatus>('GET', '/api/auth/totp'),
  totpSetup: () => api<TotpSetup>('POST', '/api/auth/totp/setup', {}),
  totpEnable: (secret: string, code: string) =>
    api<{ recoveryCodes: string[] }>('POST', '/api/auth/totp/enable', { secret, code }),
  totpDisable: (password: string) =>
    api<{ ok: true }>('POST', '/api/auth/totp/disable', { password }),
  totpNewCodes: (password: string) =>
    api<{ recoveryCodes: string[] }>('POST', '/api/auth/totp/recovery-codes', { password }),
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
  resetTwoStep: (id: string) => api<{ ok: true }>('POST', `/api/users/${id}/reset-two-step`, {}),
};

export const extensionsApi = {
  list: () => api<ListResponse<ExtensionDto>>('GET', '/api/extensions').then((r) => r.items),
  get: (id: string) => api<ExtensionDto>('GET', `/api/extensions/${id}`),
  softphoneQr: (id: string) => api<SoftphoneQr>('GET', `/api/extensions/${id}/softphone-qr`),
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
  voipmsServers: (id: string) =>
    api<{ servers: string[] }>('GET', `/api/trunks/${id}/voipms-servers`).then((r) => r.servers),
  voipmsDids: (id: string) =>
    api<ListResponse<VoipmsDidDto>>('GET', `/api/trunks/${id}/import-dids`).then((r) => r.items),
  importDids: (id: string, numbers: string[]) =>
    api<{ added: number }>('POST', `/api/trunks/${id}/import-dids`, { numbers }),
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
  tls: () => api<TlsCert>('GET', '/api/system/tls'),
  backups: () => api<BackupDto[]>('GET', '/api/system/backups'),
  backupNow: () => api<BackupDto>('POST', '/api/system/backups'),
  setupStatus: () => api<{ completed: boolean }>('GET', '/api/setup/status'),
  completeSetup: () => api<{ ok: true }>('POST', '/api/setup/complete'),
};

export const meApi = {
  calls: (cursor?: string) =>
    api<ListResponse<MyCallDto>>('GET', `/api/me/calls${cursor ? `?cursor=${cursor}` : ''}`),
  get: () => api<MeDto>('GET', '/api/me'),
  softphoneQr: () => api<SoftphoneQr>('GET', '/api/me/softphone-qr'),
  update: (m: MeUpdate) => api<MeDto>('PATCH', '/api/me', m),
  webrtc: () => api<WebRtcCreds>('GET', '/api/me/webrtc'),
  /** Log in to (unpause) or out of (pause) a queue I'm an agent of. */
  setQueuePaused: (queueId: string, paused: boolean) =>
    api<{ ok: true }>('POST', `/api/me/queues/${queueId}/${paused ? 'pause' : 'unpause'}`),
  clickToCall: (number: string) => api<{ ok: true }>('POST', '/api/me/click-to-call', { number }),
  voicemail: () => api<ListResponse<VoicemailDto>>('GET', '/api/me/voicemail').then((r) => r.items),
  audioUrl: (id: string, download = false) =>
    `/api/me/voicemail/${id}/audio${download ? '?download=1' : ''}`,
  moveVoicemail: (id: string, folder: 'INBOX' | 'Old') =>
    api<VoicemailDto>('PATCH', `/api/me/voicemail/${id}`, { folder }),
  deleteVoicemail: (id: string) => api<{ ok: true }>('DELETE', `/api/me/voicemail/${id}`),
  greetings: () => api<Record<GreetingKind, boolean>>('GET', '/api/me/greetings'),
  greetingUrl: (kind: GreetingKind) => `/api/me/greetings/${kind}/audio`,
  /** The raw recording or file is the body; the server converts it with ffmpeg. */
  putGreeting: (kind: GreetingKind, audio: Blob) =>
    upload<{ ok: true }>('PUT', `/api/me/greetings/${kind}`, audio),
  deleteGreeting: (kind: GreetingKind) => api<{ ok: true }>('DELETE', `/api/me/greetings/${kind}`),
};

export const soundsApi = {
  list: () => api<ListResponse<SoundDto>>('GET', '/api/sounds').then((r) => r.items),
  audioUrl: (id: string) => `/api/sounds/${id}/audio`,
  upload: (name: string, file: File) =>
    upload<SoundDto>(
      'POST',
      `/api/sounds?${new URLSearchParams({ name, filename: file.name })}`,
      file,
    ),
  rename: (id: string, name: string) => api<SoundDto>('PATCH', `/api/sounds/${id}`, { name }),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/sounds/${id}`),
};

export const mohApi = {
  list: () => api<ListResponse<MohClassDto>>('GET', '/api/moh-classes').then((r) => r.items),
  create: (name: string) => api<MohClassDto>('POST', '/api/moh-classes', { name }),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/moh-classes/${id}`),
  addFile: (id: string, name: string, file: File) =>
    upload<MohClassDto>(
      'POST',
      `/api/moh-classes/${id}/files?${new URLSearchParams({ name, filename: file.name })}`,
      file,
    ),
  audioUrl: (id: string, fileId: string) => `/api/moh-classes/${id}/files/${fileId}/audio`,
  removeFile: (id: string, fileId: string) =>
    api<{ ok: true }>('DELETE', `/api/moh-classes/${id}/files/${fileId}`),
};

export const ringGroupsApi = {
  list: () => api<ListResponse<RingGroupDto>>('GET', '/api/ring-groups').then((r) => r.items),
  create: (g: RingGroupCreate) => api<RingGroupDto>('POST', '/api/ring-groups', g),
  update: (id: string, g: RingGroupUpdate) =>
    api<RingGroupDto>('PATCH', `/api/ring-groups/${id}`, g),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/ring-groups/${id}`),
};

export const queuesApi = {
  list: () => api<ListResponse<QueueDto>>('GET', '/api/queues').then((r) => r.items),
  get: (id: string) => api<QueueDto>('GET', `/api/queues/${id}`),
  create: (q: QueueCreate) => api<QueueDto>('POST', '/api/queues', q),
  update: (id: string, q: QueueUpdate) => api<QueueDto>('PATCH', `/api/queues/${id}`, q),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/queues/${id}`),
  /** Today (company time zone) unless from/to (YYYY-MM-DD) are given. */
  stats: (id: string) => api<QueueStats>('GET', `/api/queues/${id}/stats`),
  setPaused: (id: string, extId: string, paused: boolean) =>
    api<{ ok: true }>('POST', `/api/queues/${id}/members/${extId}/${paused ? 'pause' : 'unpause'}`),
};

export const conferencesApi = {
  list: () => api<ListResponse<ConferenceDto>>('GET', '/api/conferences').then((r) => r.items),
  create: (c: ConferenceCreate) => api<ConferenceDto>('POST', '/api/conferences', c),
  update: (id: string, c: ConferenceUpdate) =>
    api<ConferenceDto>('PATCH', `/api/conferences/${id}`, c),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/conferences/${id}`),
};

export const devicesApi = {
  list: () => api<ListResponse<DeviceDto>>('GET', '/api/devices').then((r) => r.items),
  create: (d: DeviceCreate) => api<DeviceDto>('POST', '/api/devices', d),
  update: (id: string, d: DeviceUpdate) => api<DeviceDto>('PATCH', `/api/devices/${id}`, d),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/devices/${id}`),
  configPreview: (id: string) =>
    api<{ file: string; content: string }>('GET', `/api/devices/${id}/config-preview`),
};

export const pagingApi = {
  list: () => api<ListResponse<PagingGroupDto>>('GET', '/api/paging-groups').then((r) => r.items),
  create: (g: PagingGroupCreate) => api<PagingGroupDto>('POST', '/api/paging-groups', g),
  update: (id: string, g: PagingGroupUpdate) =>
    api<PagingGroupDto>('PATCH', `/api/paging-groups/${id}`, g),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/paging-groups/${id}`),
};

export const ivrsApi = {
  list: () => api<ListResponse<IvrDto>>('GET', '/api/ivrs').then((r) => r.items),
  create: (r: IvrCreate) => api<IvrDto>('POST', '/api/ivrs', r),
  update: (id: string, r: IvrUpdate) => api<IvrDto>('PATCH', `/api/ivrs/${id}`, r),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/ivrs/${id}`),
};

export const timeConditionsApi = {
  list: () =>
    api<ListResponse<TimeConditionDto>>('GET', '/api/time-conditions').then((r) => r.items),
  create: (t: TimeConditionCreate) => api<TimeConditionDto>('POST', '/api/time-conditions', t),
  update: (id: string, t: TimeConditionUpdate) =>
    api<TimeConditionDto>('PATCH', `/api/time-conditions/${id}`, t),
  override: (id: string, state: OverrideState) =>
    api<TimeConditionDto>('POST', `/api/time-conditions/${id}/override`, { state }),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/time-conditions/${id}`),
};

export const holidaysApi = {
  list: () => api<ListResponse<HolidayDto>>('GET', '/api/holidays').then((r) => r.items),
  create: (h: HolidayInput) => api<HolidayDto>('POST', '/api/holidays', h),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/holidays/${id}`),
  importUsFederal: (year: number) =>
    api<{ added: number }>('POST', '/api/holidays/import-us-federal', { year }),
};

export const announcementsApi = {
  list: () => api<ListResponse<AnnouncementDto>>('GET', '/api/announcements').then((r) => r.items),
  create: (a: AnnouncementCreate) => api<AnnouncementDto>('POST', '/api/announcements', a),
  update: (id: string, a: AnnouncementUpdate) =>
    api<AnnouncementDto>('PATCH', `/api/announcements/${id}`, a),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/announcements/${id}`),
};

export const blockedApi = {
  list: () => api<ListResponse<BlockedDto>>('GET', '/api/blocked-numbers').then((r) => r.items),
  create: (b: BlockedCreate) => api<BlockedDto>('POST', '/api/blocked-numbers', b),
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/blocked-numbers/${id}`),
};

/** Filters as a query string (empty values left out). */
export const callQuery = (f: CallFilter) =>
  new URLSearchParams(
    Object.entries(f).filter(([, v]) => v !== undefined && v !== '') as [string, string][],
  ).toString();

export const callsApi = {
  list: (f: CallFilter) => api<ListResponse<CallDto>>('GET', `/api/calls?${callQuery(f)}`),
  get: (id: string) => api<CallDetailDto>('GET', `/api/calls/${id}`),
  csvUrl: (f: CallFilter) => `/api/calls/export.csv?${callQuery({ ...f, cursor: undefined })}`,
};

export const recordingsApi = {
  list: (cursor?: string) =>
    api<ListResponse<RecordingDto>>('GET', `/api/recordings${cursor ? `?cursor=${cursor}` : ''}`),
  audioUrl: (id: string, download = false) =>
    `/api/recordings/${id}/audio${download ? '?download=1' : ''}`,
  remove: (id: string) => api<{ ok: true }>('DELETE', `/api/recordings/${id}`),
};

export const liveApi = {
  hangup: (linkedid: string) => api<{ ok: true }>('POST', `/api/live/calls/${linkedid}/hangup`, {}),
  transfer: (linkedid: string, target: string) =>
    api<{ ok: true }>('POST', `/api/live/calls/${linkedid}/transfer`, { target }),
  spy: (linkedid: string, mode: SpyMode) =>
    api<{ ok: true }>('POST', `/api/live/calls/${linkedid}/spy`, { mode }),
};

export type SpyMode = 'listen' | 'whisper' | 'barge';
