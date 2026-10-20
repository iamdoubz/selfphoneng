# 02 — Data model (PostgreSQL 18)

The DDL below is the contract. `apps/api/src/db/schema.ts` (drizzle) must
produce exactly these tables. Generate migrations with `drizzle-kit generate`.
Never edit an applied migration. Add a new one instead.

Conventions:
- Primary keys: `uuid` with `default gen_random_uuid()` unless stated (built into PostgreSQL 18, so no pgcrypto extension is needed).
- Every table has `created_at timestamptz not null default now()` and
  `updated_at timestamptz not null default now()` (left out below to save space,
  **but add them**). Exceptions: `cdr`, `audit_log`, `system_events`, `webhook_deliveries`, `generator_runs` (append-only, `created_at` only).
- Columns ending in `_enc` hold secrets encrypted with AES-256-GCM using
  `APP_SECRET` (format: `base64(iv[12] | tag[16] | ciphertext)`). Only
  `crypto/secrets.ts` encrypts and decrypts. API responses never include `_enc`
  values. They return `"********"` or a `hasPassword: true` flag.
- "Internal number" columns are `text` holding digits only (validated in the API).
- External numbers use the normalized format from `00-overview.md` §8.

## 1. The `Destination` type (used in many tables)

A destination says "where a call goes next". It is stored as `jsonb` and
validated by the zod schema `DestinationSchema` in `packages/shared/src/destination.ts`:

```ts
export const DestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'),           id: z.string().uuid() }), // extensions.id; rings, then that user's no-answer handling
  z.object({ type: z.literal('voicemail'),      id: z.string().uuid() }), // extensions.id; straight to voicemail
  z.object({ type: z.literal('ring_group'),     id: z.string().uuid() }),
  z.object({ type: z.literal('queue'),          id: z.string().uuid() }),
  z.object({ type: z.literal('ivr'),            id: z.string().uuid() }),
  z.object({ type: z.literal('time_condition'), id: z.string().uuid() }),
  z.object({ type: z.literal('conference'),     id: z.string().uuid() }),
  z.object({ type: z.literal('announcement'),   id: z.string().uuid() }),
  z.object({ type: z.literal('external'),       number: z.string() }),    // normalized external number
  z.object({ type: z.literal('hangup') }),
]);
```

Because jsonb can't have foreign keys, the API must:
- check the referenced row exists when saving (`services/destinations.ts → assertDestinationExists`)
- refuse to delete any row that a destination points to, and return HTTP 409 with the list of
  places using it (`services/destinations.ts → findReferences(type, id)`, which
  scans every jsonb destination column listed in this file).

Destination columns (keep this list in sync with `findReferences`):
`dids.destination`, `ring_groups.no_answer_destination`,
`queues.timeout_destination`, `ivrs.timeout_destination`,
`ivrs.invalid_destination`, `ivr_options.destination`,
`time_conditions.open_destination`, `time_conditions.closed_destination`,
`time_conditions.holiday_destination`, `announcements.destination`,
`settings['routing.unmatchedDidDestination']`.

## 2. DDL

```sql
create extension if not exists citext;

-- ───────────── settings ─────────────
-- Key/value app settings. Keys are listed in §3. Values are JSON.
create table settings (
  key   text primary key,
  value jsonb not null
);

-- ───────────── people and auth ─────────────
create type user_role as enum ('admin', 'user');

create table users (
  id               uuid primary key default gen_random_uuid(),
  email            citext not null unique,
  display_name     text not null,
  password_hash    text not null,                 -- argon2id
  role             user_role not null default 'user',
  is_active        boolean not null default true,
  totp_secret_enc  text,                          -- null = 2FA off (M11)
  totp_recovery_hashes text[] not null default '{}', -- sha256 of unused recovery codes (M11)
  totp_last_step   bigint,                        -- last 30 s step signed in with: no replay (M11)
  must_change_password boolean not null default false,
  last_login_at    timestamptz
);

create table sessions (
  id           text primary key,                  -- sha256(token) hex; raw token only in cookie
  user_id      uuid not null references users(id) on delete cascade,
  expires_at   timestamptz not null,
  ip           inet,
  user_agent   text
);
create index on sessions (user_id);

create table api_tokens (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  token_prefix  text not null,                    -- first 8 chars, shown in UI
  token_hash    text not null unique,             -- sha256 hex
  created_by    uuid not null references users(id),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- ───────────── extensions (telephony identity of a user) ─────────────
create type outbound_class as enum ('internal', 'local', 'national', 'international');
create type record_mode   as enum ('never', 'inbound', 'outbound', 'all');

create table extensions (
  id                        uuid primary key default gen_random_uuid(),
  number                    text not null unique,          -- e.g. '101'
  user_id                   uuid unique references users(id) on delete set null,
  name                      text not null,                 -- caller ID name, e.g. 'Dan Doe'
  sip_password_enc          text not null,                 -- generated, 24 chars, never user-chosen
  webrtc_enabled            boolean not null default true,
  max_contacts              int not null default 5,
  ring_seconds              int not null default 25,       -- 5..120
  voicemail_enabled         boolean not null default true,
  voicemail_pin_enc         text not null,                 -- 4–10 digits
  voicemail_email           boolean not null default true,  -- email new voicemails to user
  voicemail_attach_audio    boolean not null default true,
  voicemail_delete_after_email boolean not null default false,
  outbound_class            outbound_class not null default 'national',
  outbound_caller_id_did_id uuid references dids(id) on delete set null,  -- see note *
  emergency_caller_id_did_id uuid references dids(id) on delete set null,
  emergency_location        text,                          -- free text e.g. "Floor 2, Room 210"
  record_mode               record_mode not null default 'never',
  pickup_group              text,                          -- e.g. 'sales'; same group can pick each other up
  language                  text not null default 'en',
  moh_class                 text not null default 'default',
  blf_numbers               text[] not null default '{}'   -- internal numbers shown as BLF keys on their phones/web
);
-- * dids is created below; in the migration create dids first or add these FKs after.

create table user_runtime_state (                          -- mirrored into AstDB, see 00 §3.3
  extension_id  uuid primary key references extensions(id) on delete cascade,
  dnd           boolean not null default false,
  cfu           text,      -- forward always to this number (internal or external)
  cfb           text,      -- forward on busy
  cfna          text       -- forward on no answer
);

-- ───────────── trunks and numbers ─────────────
create type trunk_provider  as enum ('voipms', 'generic');
create type sip_transport   as enum ('udp', 'tcp', 'tls');
create type trunk_auth_mode as enum ('registration', 'ip');

create table trunks (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null unique,
  provider             trunk_provider not null default 'voipms',
  enabled              boolean not null default true,
  server_host          text not null,                    -- e.g. 'chicago1.voip.ms'
  server_port          int not null default 5060,
  transport            sip_transport not null default 'udp',
  auth_mode            trunk_auth_mode not null default 'registration',
  username             text,                             -- voip.ms sub-account e.g. '123456_pbx'
  password_enc         text,
  from_user            text,                             -- defaults to username
  from_domain          text,                             -- defaults to server_host
  codecs               text[] not null default '{ulaw}', -- allowed: ulaw, alaw, g722
  srtp                 boolean not null default false,   -- only with transport=tls
  max_channels         int,                              -- null = unlimited
  -- voip.ms REST API (SMS, DID import). Optional.
  voipms_api_username  text,
  voipms_api_password_enc text
);

create table dids (
  id                   uuid primary key default gen_random_uuid(),
  number               text not null unique,             -- normalized, '13125551234'
  trunk_id             uuid not null references trunks(id) on delete restrict,
  label                text,                             -- 'Main line'
  destination          jsonb not null,                   -- Destination
  caller_id_name_prefix text,                            -- e.g. 'SALES:' prepended to caller name
  record_inbound       boolean not null default false,
  sms_enabled          boolean not null default false,
  e911_address         text                              -- informational; real address is set at voip.ms
);

create table did_sms_users (                             -- who may read/send SMS for a DID
  did_id  uuid not null references dids(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (did_id, user_id)
);

create table outbound_routes (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  position               int not null,                   -- lower = matched first
  enabled                boolean not null default true,
  patterns               jsonb not null,  -- [{ "match": "NXXNXXXXXX", "strip": 0, "prepend": "1" }]
  required_class         outbound_class not null,        -- caller's class must be >= this
  trunk_ids              uuid[] not null,                -- tried in order (failover)
  caller_id_did_id       uuid references dids(id) on delete set null  -- overrides user's CID
);

create table blocked_numbers (
  id      uuid primary key default gen_random_uuid(),
  number  text not null unique,                          -- normalized; mirrored to AstDB SP/BLOCK
  reason  text
);

-- ───────────── call handling objects ─────────────
create type ring_strategy as enum ('ringall', 'hunt');

create table ring_groups (
  id                    uuid primary key default gen_random_uuid(),
  number                text not null unique,
  name                  text not null,
  strategy              ring_strategy not null default 'ringall',
  ring_seconds          int not null default 25,         -- ringall: total; hunt: per member
  caller_id_name_prefix text,
  music_instead_of_ring boolean not null default false,
  no_answer_destination jsonb not null                   -- Destination
);

create table ring_group_members (
  ring_group_id  uuid not null references ring_groups(id) on delete cascade,
  extension_id   uuid not null references extensions(id) on delete cascade,
  position       int not null,
  primary key (ring_group_id, extension_id)
);

create type queue_strategy as enum ('ringall', 'leastrecent', 'fewestcalls', 'random', 'rrmemory', 'linear');

create table queues (
  id                    uuid primary key default gen_random_uuid(),
  number                text not null unique,
  name                  text not null,
  strategy              queue_strategy not null default 'rrmemory',
  member_ring_seconds   int not null default 15,
  retry_seconds         int not null default 5,
  wrapup_seconds        int not null default 10,
  max_wait_seconds      int not null default 300,
  max_callers           int not null default 0,          -- 0 = unlimited
  moh_class             text not null default 'default',
  announce_position     boolean not null default true,
  announce_every_seconds int not null default 60,
  join_when_no_agents   boolean not null default false,
  record                boolean not null default false,
  sla_seconds           int not null default 20,         -- for reports
  caller_id_name_prefix text,
  timeout_destination   jsonb not null                   -- Destination when max wait reached / no agents
);

create table queue_members (
  queue_id      uuid not null references queues(id) on delete cascade,
  extension_id  uuid not null references extensions(id) on delete cascade,
  penalty       int not null default 0,
  primary key (queue_id, extension_id)
);
-- Agent logged in/out lives in AstDB SP/QPAUSE and table queue_member_state:
create table queue_member_state (
  queue_id      uuid not null references queues(id) on delete cascade,
  extension_id  uuid not null references extensions(id) on delete cascade,
  paused        boolean not null default false,
  primary key (queue_id, extension_id)
);
-- One caller's stay in a queue, from app_queue's AMI events (QueueCallerJoin, AgentConnect,
-- QueueCallerAbandon) and the dialplan's UserEvent SpQueueExit (03 §6.8); for queue stats.
-- CDRs can't do this: when no agent rang, the Queue part of a call is merged into the next leg.
create type queue_outcome as enum ('answered', 'abandoned', 'timed_out');
create table queue_calls (
  id                 bigserial primary key,
  queue_id           uuid not null references queues(id) on delete cascade,
  uniqueid           text not null,                    -- the caller's channel
  linkedid           text not null,
  joined_at          timestamptz not null default now(),
  outcome            queue_outcome,                    -- null while waiting
  wait_seconds       int,
  agent_extension_id uuid references extensions(id) on delete set null
);
create index on queue_calls (queue_id, joined_at);
create index on queue_calls (uniqueid);

create table sound_files (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  kind              text not null check (kind in ('prompt', 'moh')),
  moh_class_id      uuid references moh_classes(id) on delete cascade,  -- when kind='moh'
  source            text not null check (source in ('upload', 'tts', 'phone')),
  tts_text          text,
  original_filename text,
  asterisk_name     text not null unique,  -- path for Playback() without extension, e.g. 'custom/3f2a...'
  duration_ms       int not null
);
create table moh_classes (
  id    uuid primary key default gen_random_uuid(),
  name  text not null unique          -- slug [a-z0-9-] (same as other slugs); 'default' is built in and not stored here
);

create table ivrs (
  id                    uuid primary key default gen_random_uuid(),
  number                text not null unique,
  name                  text not null,
  greeting_sound_id     uuid not null references sound_files(id) on delete restrict,
  invalid_sound_id      uuid references sound_files(id) on delete set null,   -- null = stock 'pbx-invalid'
  timeout_seconds       int not null default 5,
  max_retries           int not null default 3,
  allow_direct_dial     boolean not null default true,     -- caller may dial an internal number
  timeout_destination   jsonb not null,
  invalid_destination   jsonb not null
);
create table ivr_options (
  ivr_id       uuid not null references ivrs(id) on delete cascade,
  digit        text not null check (digit ~ '^[0-9*#]$'),
  destination  jsonb not null,
  primary key (ivr_id, digit)
);

create table time_conditions (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  timezone             text not null,          -- IANA, e.g. 'America/Chicago'
  open_ranges          jsonb not null,         -- [{ "days": ["mon","tue"], "start": "08:00", "end": "17:00" }]
  use_holidays         boolean not null default true,
  override_digit       smallint unique check (override_digit between 1 and 9),  -- feature codes *31N/*32N/*33N
  override_state       text check (override_state in ('open', 'closed')),     -- null = automatic; mirrored to AstDB SP/TCOVR
  open_destination     jsonb not null,
  closed_destination   jsonb not null,
  holiday_destination  jsonb                   -- null = use closed_destination
);

create table holidays (                        -- global, used by every time condition with use_holidays
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  start_date  date not null,
  end_date    date not null,                   -- inclusive; = start_date for one day
  recurring_yearly boolean not null default false
);

create table announcements (                   -- play a sound, then continue
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  sound_id     uuid not null references sound_files(id) on delete restrict,
  destination  jsonb not null
);

create table conferences (
  id           uuid primary key default gen_random_uuid(),
  number       text not null unique,
  name         text not null,
  pin_enc      text,                           -- null = no PIN
  admin_pin_enc text,
  max_members  int not null default 20,
  record       boolean not null default false
);

create table paging_groups (
  id          uuid primary key default gen_random_uuid(),
  number      text not null unique,
  name        text not null,
  duplex      boolean not null default false   -- false = one-way page, true = intercom
);
create table paging_group_members (
  paging_group_id uuid not null references paging_groups(id) on delete cascade,
  extension_id    uuid not null references extensions(id) on delete cascade,
  primary key (paging_group_id, extension_id)
);

-- ───────────── devices (provisioning) ─────────────
create type phone_vendor as enum ('yealink', 'grandstream', 'polycom', 'generic');

create table devices (
  id                       uuid primary key default gen_random_uuid(),
  extension_id             uuid not null references extensions(id) on delete cascade,
  mac                      text not null unique,      -- 12 lowercase hex chars, no separators
  vendor                   phone_vendor not null,
  model                    text,
  label                    text,
  provisioning_password_enc text not null,            -- HTTP basic auth password for this device
  last_provisioned_at      timestamptz,
  last_provisioned_ip      inet
);

-- ───────────── history, media, messaging ─────────────
create table cdr (                                    -- one row per AMI Cdr event, raw
  id           bigserial primary key,
  created_at   timestamptz not null default now(),
  uniqueid     text not null,
  linkedid     text not null,
  start_at     timestamptz,
  answer_at    timestamptz,
  end_at       timestamptz,
  duration     int, billsec int,
  src text, dst text, dcontext text, clid text,
  channel text, dstchannel text, lastapp text, lastdata text,
  disposition  text,                                  -- ANSWERED, NO ANSWER, BUSY, FAILED, CONGESTION
  accountcode  text, userfield text,
  sp_did       text, sp_direction text, sp_recording text,
  raw          jsonb not null
);
create index on cdr (linkedid);

create type call_direction as enum ('inbound', 'outbound', 'internal');
create type call_status    as enum ('answered', 'missed', 'voicemail', 'abandoned', 'busy', 'failed');

create table calls (                                  -- one row per logical call (linkedid)
  id                    uuid primary key default gen_random_uuid(),
  linkedid              text not null unique,
  direction             call_direction not null,
  status                call_status not null,
  started_at            timestamptz not null,
  answered_at           timestamptz,
  ended_at              timestamptz not null,
  from_number           text, from_name text,
  to_number             text,
  did_id                uuid references dids(id) on delete set null,
  answered_by_extension_id uuid references extensions(id) on delete set null,
  talk_seconds          int not null default 0,
  recording_id          uuid references recordings(id) on delete set null
);
create index on calls (started_at desc);

create table call_extensions (                        -- which extensions were involved (for per-user history)
  call_id       uuid not null references calls(id) on delete cascade,
  extension_id  uuid not null references extensions(id) on delete cascade,
  role          text not null check (role in ('caller', 'rang', 'answered')),
  primary key (call_id, extension_id, role)
);

create table recordings (
  id           uuid primary key default gen_random_uuid(),
  linkedid     text not null,
  file_path    text not null unique,                  -- relative to recordings root
  started_at   timestamptz not null,
  duration_ms  int,
  size_bytes   bigint
);

create table voicemail_messages (                     -- index of files Asterisk wrote
  id             uuid primary key default gen_random_uuid(),
  extension_id   uuid not null references extensions(id) on delete cascade,
  msg_id         text not null unique,                -- 'msg_id' field from msgNNNN.txt
  folder         text not null,                       -- INBOX | Old | Urgent
  caller_number  text, caller_name text,
  duration_s     int not null,
  received_at    timestamptz not null,
  file_path      text not null,                       -- current path to .wav
  emailed_at     timestamptz,
  deleted_at     timestamptz
);

create table contacts (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,   -- null = company phonebook
  name          text not null,
  company       text,
  email         text,
  numbers       jsonb not null,                        -- [{ "label": "mobile", "number": "13125551234" }]
  notes         text
);

create table sms_messages (
  id               uuid primary key default gen_random_uuid(),
  did_id           uuid not null references dids(id) on delete cascade,
  direction        text not null check (direction in ('in', 'out')),
  remote_number    text not null,
  body             text not null,
  media            jsonb not null default '[]',        -- [{ "url": "...", "contentType": "image/jpeg" }]
  status           text not null,                      -- queued | sent | failed | received
  provider_id      text,
  error            text,
  sent_by_user_id  uuid references users(id) on delete set null,
  read_at          timestamptz
);
create index on sms_messages (did_id, remote_number, created_at desc);

-- ───────────── integration, audit, system ─────────────
create table webhooks (
  id          uuid primary key default gen_random_uuid(),
  url         text not null,
  secret_enc  text not null,                           -- HMAC-SHA256 signing secret
  events      text[] not null,                         -- see 04 §9
  enabled     boolean not null default true
);
create table webhook_deliveries (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  webhook_id    uuid not null references webhooks(id) on delete cascade,
  event         text not null,
  payload       jsonb not null,
  attempt       int not null default 0,
  status        text not null,                         -- pending | ok | failed
  response_code int,
  next_attempt_at timestamptz
);

create table emergency_events (
  id               uuid primary key default gen_random_uuid(),
  extension_number text not null,
  dialed           text not null,
  caller_id_used   text not null,
  location         text,
  notified         jsonb not null default '[]'          -- [{ "channel": "email", "to": "...", "ok": true }]
);

create table audit_log (
  id           bigserial primary key,
  created_at   timestamptz not null default now(),
  actor_user_id uuid references users(id) on delete set null,
  actor_ip     inet,
  action       text not null,         -- 'create' | 'update' | 'delete' | 'login' | 'login_failed' | ...
  entity_type  text,
  entity_id    text,
  summary      text not null,
  diff         jsonb                  -- secrets replaced with "********"
);

-- Added 2026-10-20 (owner follow-ups to M11-T7): the System page's event log (05 §2), kept 90 days.
create table system_events (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  severity    text not null check (severity in ('info', 'warning', 'error')),
  code        text not null,          -- 'trunk.down', 'telephony.restartNeeded', 'backup.failed', ...
  source      text not null,          -- 'Trunk', 'Telephony', 'Backup', ...
  message     text not null
);
create index on system_events (created_at);

create table generator_runs (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  trigger       text not null,        -- 'api-change' | 'startup' | 'nightly' | 'manual'
  files_changed text[] not null,
  commands      text[] not null,      -- AMI commands sent
  ok            boolean not null,
  error         text,
  duration_ms   int not null
);
```

Table creation order in the migration must respect foreign keys: `moh_classes`
before `sound_files`, `trunks` → `dids` → `extensions`, `recordings` before `calls`.

## 3. Settings keys

All values are JSON. `services/settings.ts` exposes `get(key)` / `set(key, value)`
with a zod schema per key and a default. Missing rows return the default.

| Key | Type | Default | Notes |
|---|---|---|---|
| `general.companyName` | string | `"My Company"` | |
| `general.timezone` | string (IANA) | value of env `TZ` | |
| `general.language` | string | `"en"` | |
| `network.publicIp` | string \| null | null | |
| `network.localNets` | string[] | `["192.168.0.0/16","10.0.0.0/8","172.16.0.0/12"]` | |
| `network.lanIp` | string \| null | null | server's own LAN address (ICE host candidate mapping) |
| `network.publicIpWatch` | boolean | false | |
| `network.stunServer` | string \| null | null | e.g. `stun.example.org:3478`. null = no STUN |
| `network.turn` | `{url,username,credentialEnc}` \| null | null | Sent to browsers for WebRTC |
| `sip.udpPort` | number | 5060 | |
| `sip.tcpEnabled` | boolean | true | |
| `sip.tlsEnabled` | boolean | false | needs cert in `/var/lib/selfphoneng/tls` |
| `sip.tlsPort` | number | 5061 | |
| `numbering.users` | `[from,to]` | `[100,499]` | ranges from 00 §7 |
| `numbering.ringGroups` | `[from,to]` | `[500,549]` | |
| `numbering.queues` | `[from,to]` | `[550,599]` | |
| `numbering.ivrs` | `[from,to]` | `[600,649]` | |
| `numbering.conferences` | `[from,to]` | `[800,849]` | |
| `numbering.paging` | `[from,to]` | `[850,869]` | |
| `routing.unmatchedDidDestination` | Destination | `{type:'hangup'}` | |
| `routing.defaultCallerIdDidId` | uuid \| null | null | caller ID when no other rule sets one |
| `smtp` | `{host,port,secure,username,passwordEnc,from}` \| null | null | |
| `voicemail.maxMessageSeconds` | number | 300 | |
| `voicemail.maxMessages` | number | 100 | |
| `voicemail.retentionDays` | number | 0 | 0 = keep forever |
| `recordings.retentionDays` | number | 90 | |
| `recordings.announcementSoundId` | uuid \| null | null | "This call may be recorded" |
| `emergency.defaultCallerIdDidId` | uuid \| null | null | **required** before 911 works, see 06 §6 |
| `emergency.notifyEmails` | string[] | `[]` | |
| `emergency.notifyExtensionIds` | uuid[] | `[]` | these phones get a call/page |
| `backup.enabled` | boolean | true | |
| `backup.time` | `"HH:MM"` | `"03:30"` | |
| `backup.keep` | number | 7 | |
| `backup.includeRecordings` | boolean | false | |
| `webhooks.allowPrivate` | boolean | false | allow webhook URLs on private/loopback IPs |
| `setup.completed` | boolean | false | first-run wizard done |
| `sms.webhookToken` | string | random 32 chars, made on first read | secret part of the voip.ms SMS callback URL |
| `sip.restrictPhonesToLocalNets` | boolean | false | only accept phone registrations from `network.localNets` (+ `sip.extraAllowedNets`) |
| `sip.extraAllowedNets` | string[] | `[]` | e.g. a VPN subnet |
| `calls.maxPerExtension` | number | 3 | outside calls going out at once per extension (the caller, or whose forward it is); 0 = no limit (08 §1) |
| `calls.maxTotal` | number | 10 | outside calls going out at once in total; 0 = no limit. 911 counts toward neither |
| `provisioning.lanOnly` | boolean | false | only serve `/prov` to clients from local nets |
| `provisioning.enabled` | boolean | true | |
| `system.restartRequired` | boolean | false | set by generator |
