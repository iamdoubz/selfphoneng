// SPDX-License-Identifier: AGPL-3.0-or-later
// Mirrors docs/spec/02-data-model.md §2 exactly. Column keys are camelCase; the db client and
// drizzle-kit both use `casing: 'snake_case'`, so `displayName` is the column `display_name`.
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const tstz = () => timestamp({ withTimezone: true });
const createdAt = () => tstz().notNull().defaultNow();
const timestamps = {
  createdAt: createdAt(),
  updatedAt: tstz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
const id = () => uuid().primaryKey().defaultRandom();
const emptyTextArray = () =>
  text()
    .array()
    .notNull()
    .default(sql`'{}'`);

// ───────────── settings ─────────────
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  ...timestamps,
});

// ───────────── people and auth ─────────────
export const userRole = pgEnum('user_role', ['admin', 'user']);

export const users = pgTable('users', {
  id: id(),
  email: citext().notNull().unique(),
  displayName: text().notNull(),
  passwordHash: text().notNull(),
  role: userRole().notNull().default('user'),
  isActive: boolean().notNull().default(true),
  totpSecretEnc: text(),
  mustChangePassword: boolean().notNull().default(false),
  lastLoginAt: tstz(),
  ...timestamps,
});

export const sessions = pgTable(
  'sessions',
  {
    id: text().primaryKey(), // sha256(token) hex; raw token only in the cookie
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: tstz().notNull(),
    ip: inet(),
    userAgent: text(),
    ...timestamps,
  },
  (t) => [index().on(t.userId)],
);

export const apiTokens = pgTable('api_tokens', {
  id: id(),
  name: text().notNull(),
  tokenPrefix: text().notNull(),
  tokenHash: text().notNull().unique(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
  lastUsedAt: tstz(),
  revokedAt: tstz(),
  ...timestamps,
});

// ───────────── extensions ─────────────
export const outboundClass = pgEnum('outbound_class', [
  'internal',
  'local',
  'national',
  'international',
]);
export const recordMode = pgEnum('record_mode', ['never', 'inbound', 'outbound', 'all']);

export const extensions = pgTable('extensions', {
  id: id(),
  number: text().notNull().unique(),
  userId: uuid()
    .unique()
    .references(() => users.id, { onDelete: 'set null' }),
  name: text().notNull(),
  sipPasswordEnc: text().notNull(),
  webrtcEnabled: boolean().notNull().default(true),
  maxContacts: integer().notNull().default(5),
  ringSeconds: integer().notNull().default(25),
  voicemailEnabled: boolean().notNull().default(true),
  voicemailPinEnc: text().notNull(),
  voicemailEmail: boolean().notNull().default(true),
  voicemailAttachAudio: boolean().notNull().default(true),
  voicemailDeleteAfterEmail: boolean().notNull().default(false),
  outboundClass: outboundClass().notNull().default('national'),
  outboundCallerIdDidId: uuid().references(() => dids.id, { onDelete: 'set null' }),
  emergencyCallerIdDidId: uuid().references(() => dids.id, { onDelete: 'set null' }),
  emergencyLocation: text(),
  recordMode: recordMode().notNull().default('never'),
  pickupGroup: text(),
  language: text().notNull().default('en'),
  mohClass: text().notNull().default('default'),
  blfNumbers: emptyTextArray(),
  ...timestamps,
});

export const userRuntimeState = pgTable('user_runtime_state', {
  extensionId: uuid()
    .primaryKey()
    .references(() => extensions.id, { onDelete: 'cascade' }),
  dnd: boolean().notNull().default(false),
  cfu: text(),
  cfb: text(),
  cfna: text(),
  ...timestamps,
});

// ───────────── trunks and numbers ─────────────
export const trunkProvider = pgEnum('trunk_provider', ['voipms', 'generic']);
export const sipTransport = pgEnum('sip_transport', ['udp', 'tcp', 'tls']);
export const trunkAuthMode = pgEnum('trunk_auth_mode', ['registration', 'ip']);

export const trunks = pgTable('trunks', {
  id: id(),
  name: text().notNull().unique(),
  provider: trunkProvider().notNull().default('voipms'),
  enabled: boolean().notNull().default(true),
  serverHost: text().notNull(),
  serverPort: integer().notNull().default(5060),
  transport: sipTransport().notNull().default('udp'),
  authMode: trunkAuthMode().notNull().default('registration'),
  username: text(),
  passwordEnc: text(),
  fromUser: text(),
  fromDomain: text(),
  codecs: text()
    .array()
    .notNull()
    .default(sql`'{ulaw}'`),
  srtp: boolean().notNull().default(false),
  maxChannels: integer(),
  voipmsApiUsername: text(),
  voipmsApiPasswordEnc: text(),
  ...timestamps,
});

export const dids = pgTable('dids', {
  id: id(),
  number: text().notNull().unique(),
  trunkId: uuid()
    .notNull()
    .references(() => trunks.id, { onDelete: 'restrict' }),
  label: text(),
  destination: jsonb().notNull(),
  callerIdNamePrefix: text(),
  recordInbound: boolean().notNull().default(false),
  smsEnabled: boolean().notNull().default(false),
  e911Address: text(),
  ...timestamps,
});

export const didSmsUsers = pgTable(
  'did_sms_users',
  {
    didId: uuid()
      .notNull()
      .references(() => dids.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.didId, t.userId] })],
);

export const outboundRoutes = pgTable('outbound_routes', {
  id: id(),
  name: text().notNull(),
  position: integer().notNull(),
  enabled: boolean().notNull().default(true),
  patterns: jsonb().notNull(),
  requiredClass: outboundClass().notNull(),
  trunkIds: uuid().array().notNull(),
  callerIdDidId: uuid().references(() => dids.id, { onDelete: 'set null' }),
  ...timestamps,
});

export const blockedNumbers = pgTable('blocked_numbers', {
  id: id(),
  number: text().notNull().unique(),
  reason: text(),
  ...timestamps,
});

// ───────────── call handling objects ─────────────
export const ringStrategy = pgEnum('ring_strategy', ['ringall', 'hunt']);

export const ringGroups = pgTable('ring_groups', {
  id: id(),
  number: text().notNull().unique(),
  name: text().notNull(),
  strategy: ringStrategy().notNull().default('ringall'),
  ringSeconds: integer().notNull().default(25),
  callerIdNamePrefix: text(),
  musicInsteadOfRing: boolean().notNull().default(false),
  noAnswerDestination: jsonb().notNull(),
  ...timestamps,
});

export const ringGroupMembers = pgTable(
  'ring_group_members',
  {
    ringGroupId: uuid()
      .notNull()
      .references(() => ringGroups.id, { onDelete: 'cascade' }),
    extensionId: uuid()
      .notNull()
      .references(() => extensions.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.ringGroupId, t.extensionId] })],
);

export const queueStrategy = pgEnum('queue_strategy', [
  'ringall',
  'leastrecent',
  'fewestcalls',
  'random',
  'rrmemory',
  'linear',
]);

export const queues = pgTable('queues', {
  id: id(),
  number: text().notNull().unique(),
  name: text().notNull(),
  strategy: queueStrategy().notNull().default('rrmemory'),
  memberRingSeconds: integer().notNull().default(15),
  retrySeconds: integer().notNull().default(5),
  wrapupSeconds: integer().notNull().default(10),
  maxWaitSeconds: integer().notNull().default(300),
  maxCallers: integer().notNull().default(0),
  mohClass: text().notNull().default('default'),
  announcePosition: boolean().notNull().default(true),
  announceEverySeconds: integer().notNull().default(60),
  joinWhenNoAgents: boolean().notNull().default(false),
  record: boolean().notNull().default(false),
  slaSeconds: integer().notNull().default(20),
  callerIdNamePrefix: text(),
  timeoutDestination: jsonb().notNull(),
  ...timestamps,
});

export const queueMembers = pgTable(
  'queue_members',
  {
    queueId: uuid()
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    extensionId: uuid()
      .notNull()
      .references(() => extensions.id, { onDelete: 'cascade' }),
    penalty: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.queueId, t.extensionId] })],
);

export const queueMemberState = pgTable(
  'queue_member_state',
  {
    queueId: uuid()
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    extensionId: uuid()
      .notNull()
      .references(() => extensions.id, { onDelete: 'cascade' }),
    paused: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.queueId, t.extensionId] })],
);

export const queueOutcome = pgEnum('queue_outcome', ['answered', 'abandoned', 'timed_out']);

/** One caller's stay in a queue, from app_queue's AMI events (stats, 04 §7.3). */
export const queueCalls = pgTable(
  'queue_calls',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    queueId: uuid()
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    /** The caller's channel. */
    uniqueid: text().notNull(),
    linkedid: text().notNull(),
    joinedAt: tstz().notNull().defaultNow(),
    /** null while waiting. */
    outcome: queueOutcome(),
    waitSeconds: integer(),
    agentExtensionId: uuid().references(() => extensions.id, { onDelete: 'set null' }),
  },
  (t) => [index().on(t.queueId, t.joinedAt), index().on(t.uniqueid)],
);

export const mohClasses = pgTable('moh_classes', {
  id: id(),
  name: text().notNull().unique(),
  ...timestamps,
});

export const soundFiles = pgTable(
  'sound_files',
  {
    id: id(),
    name: text().notNull(),
    kind: text().notNull(),
    mohClassId: uuid().references(() => mohClasses.id, { onDelete: 'cascade' }),
    source: text().notNull(),
    ttsText: text(),
    originalFilename: text(),
    asteriskName: text().notNull().unique(),
    durationMs: integer().notNull(),
    ...timestamps,
  },
  (t) => [
    check('sound_files_kind_check', sql`${t.kind} in ('prompt', 'moh')`),
    check('sound_files_source_check', sql`${t.source} in ('upload', 'tts', 'phone')`),
  ],
);

export const ivrs = pgTable('ivrs', {
  id: id(),
  number: text().notNull().unique(),
  name: text().notNull(),
  greetingSoundId: uuid()
    .notNull()
    .references(() => soundFiles.id, { onDelete: 'restrict' }),
  invalidSoundId: uuid().references(() => soundFiles.id, { onDelete: 'set null' }),
  timeoutSeconds: integer().notNull().default(5),
  maxRetries: integer().notNull().default(3),
  allowDirectDial: boolean().notNull().default(true),
  timeoutDestination: jsonb().notNull(),
  invalidDestination: jsonb().notNull(),
  ...timestamps,
});

export const ivrOptions = pgTable(
  'ivr_options',
  {
    ivrId: uuid()
      .notNull()
      .references(() => ivrs.id, { onDelete: 'cascade' }),
    digit: text().notNull(),
    destination: jsonb().notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.ivrId, t.digit] }),
    check('ivr_options_digit_check', sql`${t.digit} ~ '^[0-9*#]$'`),
  ],
);

export const timeConditions = pgTable(
  'time_conditions',
  {
    id: id(),
    name: text().notNull(),
    timezone: text().notNull(),
    openRanges: jsonb().notNull(),
    useHolidays: boolean().notNull().default(true),
    overrideDigit: smallint().unique(),
    overrideState: text(),
    openDestination: jsonb().notNull(),
    closedDestination: jsonb().notNull(),
    holidayDestination: jsonb(),
    ...timestamps,
  },
  (t) => [
    check('time_conditions_override_digit_check', sql`${t.overrideDigit} between 1 and 9`),
    check('time_conditions_override_state_check', sql`${t.overrideState} in ('open', 'closed')`),
  ],
);

export const holidays = pgTable('holidays', {
  id: id(),
  name: text().notNull(),
  startDate: date().notNull(),
  endDate: date().notNull(),
  recurringYearly: boolean().notNull().default(false),
  ...timestamps,
});

export const announcements = pgTable('announcements', {
  id: id(),
  name: text().notNull(),
  soundId: uuid()
    .notNull()
    .references(() => soundFiles.id, { onDelete: 'restrict' }),
  destination: jsonb().notNull(),
  ...timestamps,
});

export const conferences = pgTable('conferences', {
  id: id(),
  number: text().notNull().unique(),
  name: text().notNull(),
  pinEnc: text(),
  adminPinEnc: text(),
  maxMembers: integer().notNull().default(20),
  record: boolean().notNull().default(false),
  ...timestamps,
});

export const pagingGroups = pgTable('paging_groups', {
  id: id(),
  number: text().notNull().unique(),
  name: text().notNull(),
  duplex: boolean().notNull().default(false),
  ...timestamps,
});

export const pagingGroupMembers = pgTable(
  'paging_group_members',
  {
    pagingGroupId: uuid()
      .notNull()
      .references(() => pagingGroups.id, { onDelete: 'cascade' }),
    extensionId: uuid()
      .notNull()
      .references(() => extensions.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.pagingGroupId, t.extensionId] })],
);

// ───────────── devices (provisioning) ─────────────
export const phoneVendor = pgEnum('phone_vendor', ['yealink', 'grandstream', 'polycom', 'generic']);

export const devices = pgTable('devices', {
  id: id(),
  extensionId: uuid()
    .notNull()
    .references(() => extensions.id, { onDelete: 'cascade' }),
  mac: text().notNull().unique(),
  vendor: phoneVendor().notNull(),
  model: text(),
  label: text(),
  provisioningPasswordEnc: text().notNull(),
  lastProvisionedAt: tstz(),
  lastProvisionedIp: inet(),
  ...timestamps,
});

// ───────────── history, media, messaging ─────────────
export const cdr = pgTable(
  'cdr',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    createdAt: createdAt(),
    uniqueid: text().notNull(),
    linkedid: text().notNull(),
    startAt: tstz(),
    answerAt: tstz(),
    endAt: tstz(),
    duration: integer(),
    billsec: integer(),
    src: text(),
    dst: text(),
    dcontext: text(),
    clid: text(),
    channel: text(),
    dstchannel: text(),
    lastapp: text(),
    lastdata: text(),
    disposition: text(),
    accountcode: text(),
    userfield: text(),
    spDid: text(),
    spDirection: text(),
    spRecording: text(),
    raw: jsonb().notNull(),
  },
  (t) => [index().on(t.linkedid)],
);

export const callDirection = pgEnum('call_direction', ['inbound', 'outbound', 'internal']);
export const callStatus = pgEnum('call_status', [
  'answered',
  'missed',
  'voicemail',
  'abandoned',
  'busy',
  'failed',
]);

export const recordings = pgTable('recordings', {
  id: id(),
  linkedid: text().notNull(),
  filePath: text().notNull().unique(),
  startedAt: tstz().notNull(),
  durationMs: integer(),
  sizeBytes: bigint({ mode: 'number' }),
  ...timestamps,
});

export const calls = pgTable(
  'calls',
  {
    id: id(),
    linkedid: text().notNull().unique(),
    direction: callDirection().notNull(),
    status: callStatus().notNull(),
    startedAt: tstz().notNull(),
    answeredAt: tstz(),
    endedAt: tstz().notNull(),
    fromNumber: text(),
    fromName: text(),
    toNumber: text(),
    didId: uuid().references(() => dids.id, { onDelete: 'set null' }),
    answeredByExtensionId: uuid().references(() => extensions.id, { onDelete: 'set null' }),
    talkSeconds: integer().notNull().default(0),
    recordingId: uuid().references(() => recordings.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index().on(t.startedAt.desc())],
);

export const callExtensions = pgTable(
  'call_extensions',
  {
    callId: uuid()
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    extensionId: uuid()
      .notNull()
      .references(() => extensions.id, { onDelete: 'cascade' }),
    role: text().notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.callId, t.extensionId, t.role] }),
    check('call_extensions_role_check', sql`${t.role} in ('caller', 'rang', 'answered')`),
  ],
);

export const voicemailMessages = pgTable('voicemail_messages', {
  id: id(),
  extensionId: uuid()
    .notNull()
    .references(() => extensions.id, { onDelete: 'cascade' }),
  msgId: text().notNull().unique(),
  folder: text().notNull(),
  callerNumber: text(),
  callerName: text(),
  durationS: integer().notNull(),
  receivedAt: tstz().notNull(),
  filePath: text().notNull(),
  emailedAt: tstz(),
  deletedAt: tstz(),
  ...timestamps,
});

export const contacts = pgTable('contacts', {
  id: id(),
  ownerUserId: uuid().references(() => users.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  company: text(),
  email: text(),
  numbers: jsonb().notNull(),
  notes: text(),
  ...timestamps,
});

export const smsMessages = pgTable(
  'sms_messages',
  {
    id: id(),
    didId: uuid()
      .notNull()
      .references(() => dids.id, { onDelete: 'cascade' }),
    direction: text().notNull(),
    remoteNumber: text().notNull(),
    body: text().notNull(),
    media: jsonb().notNull().default([]),
    status: text().notNull(),
    providerId: text(),
    error: text(),
    sentByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    readAt: tstz(),
    ...timestamps,
  },
  (t) => [
    index().on(t.didId, t.remoteNumber, t.createdAt.desc()),
    check('sms_messages_direction_check', sql`${t.direction} in ('in', 'out')`),
  ],
);

// ───────────── integration, audit, system ─────────────
export const webhooks = pgTable('webhooks', {
  id: id(),
  url: text().notNull(),
  secretEnc: text().notNull(),
  events: text().array().notNull(),
  enabled: boolean().notNull().default(true),
  ...timestamps,
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  createdAt: createdAt(),
  webhookId: uuid()
    .notNull()
    .references(() => webhooks.id, { onDelete: 'cascade' }),
  event: text().notNull(),
  payload: jsonb().notNull(),
  attempt: integer().notNull().default(0),
  status: text().notNull(),
  responseCode: integer(),
  nextAttemptAt: tstz(),
});

export const emergencyEvents = pgTable('emergency_events', {
  id: id(),
  extensionNumber: text().notNull(),
  dialed: text().notNull(),
  callerIdUsed: text().notNull(),
  location: text(),
  notified: jsonb().notNull().default([]),
  ...timestamps,
});

export const auditLog = pgTable('audit_log', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  createdAt: createdAt(),
  actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
  actorIp: inet(),
  action: text().notNull(),
  entityType: text(),
  entityId: text(),
  summary: text().notNull(),
  diff: jsonb(),
});

export const generatorRuns = pgTable('generator_runs', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  createdAt: createdAt(),
  trigger: text().notNull(),
  filesChanged: text().array().notNull(),
  commands: text().array().notNull(),
  ok: boolean().notNull(),
  error: text(),
  durationMs: integer().notNull(),
});
