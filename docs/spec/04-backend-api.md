# 04 — Backend (apps/api)

## 1. Startup order (`src/index.ts`)

1. `config.ts`: parse env with zod. Exit 1 with a readable message on error.
2. Create the pino logger (with redaction, §11).
3. Connect PostgreSQL. Run migrations from `./migrations`.
4. Bootstrap: if no `admin` user exists, create one from `INITIAL_ADMIN_EMAIL` /
   `INITIAL_ADMIN_PASSWORD` with `must_change_password = true`.
5. Build Fastify: plugins (cookie, rate-limit, multipart, websocket, static for
   `./public` with SPA fallback to `index.html` for non-`/api`, non-`/prov`, non-`/hooks` paths), then routes.
6. Listen on `127.0.0.1:${API_PORT}`.
7. Start the AMI client (§4). On every successful login: sync AstDB (§5.5),
   `generator.apply({ trigger: 'startup', force: true })`, then load live state (§5.1). The apply comes
   first so hints for extensions created while Asterisk was away exist before their states are read.
8. Start the voicemail watcher (§5.6) and the jobs (§8).
9. On SIGTERM: stop jobs, close WS clients, close AMI, close DB, exit 0.

## 2. Auth

### 2.1 Passwords
- argon2id via `@node-rs/argon2` with library defaults.
- Minimum 10 characters. Reject the 1,000 most common passwords (bundle a list in `auth/common-passwords.txt`).

### 2.2 Sessions (browser)
- `POST /api/auth/login {email, password, totp?}` (`totp`: the code or a recovery code; when 2FA is on
  and it's missing, 401 `totp_required`; wrong, 401 `totp_invalid`; M11-T1; also `GET /api/auth/totp`,
  `POST /api/auth/totp/setup|enable|disable|recovery-codes`, 08 §2.4) → on success, create a 32-byte random
  token. Store `sha256(token)` in `sessions.id` and set the cookie
  `sp_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600` (14 days).
- Sliding expiry: if a session has less than 7 days left when used, extend it to 14 days.
- `POST /api/auth/logout` deletes the session row and clears the cookie.
- **CSRF:** every non-GET `/api/*` request with cookie auth must carry the header
  `X-Requested-With: selfphoneng`. The web client always sends it. Browsers can't send
  it cross-site without CORS, and CORS is off.
- Login rate limit: 5 failures per IP per 15 min and 10 per email per hour → HTTP 429. A signed-in
  person's password asked again (change password, two-step on/off, recovery codes) counts the same.
- Every route: `@fastify/rate-limit`, `RATE_LIMIT_PER_MINUTE` (default 600) per client IP → 429
  `rate_limited`. Test buttons, diagnostics and the source download: 10 a minute (`SLOW` in
  `auth/guards.ts`). `/prov` (its own limits, 07 §2) and the caller-name route (Asterisk on this
  machine) are outside it (`NO_LIMIT`).
  Write `login_failed` to the audit log with the IP.
- If `must_change_password`, every route except `/api/auth/*` returns 403 `{code:'password_change_required'}`.
- Single sign-on (spec 12, as built in S1): the body is `{login, password, totp?}` (`login`: email, or a
  directory username from S4; `email` is still accepted). A user without a password fails like a wrong
  one. `auth.mode = 'oidc'` refuses passwords for non-admins (403 `password_sign_in_off`).
  `GET /api/auth/methods` (public) → `{mode, ldap, oidc}` for the login page. The last active admin
  **with a password** can't be deleted, disabled or demoted.

### 2.3 API tokens (integrations)
- Header `Authorization: Bearer sp_<40 random base62 chars>`. Stored as sha256.
  Tokens act as the admin who created them. Shown once on creation.

As built (M11-T5): `auth/tokens.ts`; `requireAuth` takes a Bearer header before the cookie (a
Bearer request never falls back to the cookie, and an unknown or revoked token is 401). The token
acts as its creator with the creator's current role, so it stops working when they're disabled.
Bearer requests don't need `X-Requested-With` (no cookie is used, and a cross-site page can't set
Authorization). A token can't list, make or revoke tokens (403): a leaked one can't make itself a
spare. `lastUsedAt` is written on every request. Settings → API tokens.

### 2.3a Mobile device tokens
`Authorization: Bearer spm_<40 base62>`, made by pairing a phone and acting as its user, never as
an admin (`requireAdmin` refuses them). See `13-mobile.md` §2 and §4.

### 2.4 Guards
Fastify `preHandler` hooks in `auth/guards.ts`:
- `requireAuth`: sets `req.user`.
- `requireAdmin`.
- `requireSelfOrAdmin(paramName)`: for `/api/me/*` and per-user resources.

## 3. Secrets (`crypto/secrets.ts`)

```ts
encrypt(plain: string): string   // AES-256-GCM, random 12-byte IV, key = base64decode(APP_SECRET)
decrypt(blob: string): string
generateSipPassword(): string    // 24 chars from [A-Za-z0-9], crypto.randomInt
generatePin(len = 6): string
```
Unit test: round-trip, tamper detection (flip one byte → throws), wrong key → throws.

## 4. AMI client (`ami/client.ts`)

Write it ourselves. Protocol summary:
- TCP to `AMI_HOST:AMI_PORT`. Server sends one banner line: `Asterisk Call Manager/X.Y.Z\r\n`.
- Each message is lines `Key: Value\r\n` ending with an empty line `\r\n`.
- A message with `Response:` answers an action (matched by `ActionID`).
  A message with `Event:` is an event.
- Keys can repeat (e.g. `Output:` lines of a `Command`, `ChanVariable:`). Parse each
  message as `Record<string, string | string[]>`, so a repeated key becomes an array.
- List actions (e.g. `PJSIPShowContacts`, `CoreShowChannels`) reply
  `Response: Success` + `EventList: start`, then events with the same `ActionID`,
  then an event whose name ends in `Complete` with `EventList: Complete`.

API:
```ts
class AmiClient extends EventEmitter {
  constructor(opts: { host; port; username; secret; logger });
  start(): void;                       // connects, logs in, reconnects forever
  isConnected(): boolean;
  action(fields: Record<string,string>, opts?: { timeoutMs?: number }): Promise<AmiMessage>;
  actionList(fields: Record<string,string>): Promise<AmiMessage[]>;   // collects an EventList
  command(cmd: string): Promise<string>;                               // Action: Command, returns joined Output
  // events: 'connected', 'disconnected', 'event' (msg), and `event:<Name>` (msg)
}
```
Details:
- `ActionID` = incrementing integer as a string, prefixed `sp-`.
- Login: `Action: Login`, `Username`, `Secret`, `Events: on`.
- Send `Action: Ping` every 20 s. If no reply in 10 s, destroy the socket and reconnect.
- Reconnect backoff: 1, 2, 4, 8, 16, 30, 30, … seconds.
- Pending actions reject with `AmiDisconnectedError` when the socket closes.
- Some list actions answer an empty list with `Response: Error` instead of an empty EventList
  (Asterisk 24: `PJSIPShowContacts` → `Message: No Contacts found`, ending in a bare LF). `actionList`
  turns `No … found` errors into `[]`. The parser strips stray CR/LF from the end of values.
- Default action timeout: 10 s.
- **Never log the Login action fields.**

Tests: run the parser against recorded raw byte streams in `test/fixtures/ami/`,
including messages split across TCP chunks and several messages in one chunk.

## 5. Live state, events and Asterisk-driven services

### 5.1 Live state (`live/state.ts`)

In memory only. Rebuilt from Asterisk on every AMI connect.

```ts
type ExtensionLive = {
  number: string;
  state: 'idle' | 'inuse' | 'busy' | 'unavailable' | 'ringing' | 'onhold' | 'ringinuse';
  contacts: { endpoint: string; uri: string; userAgent?: string; status: 'reachable'|'unreachable'|'unknown'; rttMs?: number }[];
  dnd: boolean;
};
type TrunkLive = { trunkId: string; registration: 'registered' | 'rejected' | 'unregistered' | 'unknown'; lastChange: string; reachable: boolean };
type ActiveCall = {
  linkedid: string; startedAt: string; answeredAt?: string;
  direction: 'inbound'|'outbound'|'internal';
  from: { number: string; name?: string }; to: { number: string; name?: string };
  did?: string; state: 'ringing' | 'talking' | 'hold' | 'queued' | 'ivr' | 'voicemail' | 'parked';
  extensions: string[];          // internal numbers involved
  channels: string[];            // channel names
  recording: boolean;
};
type QueueLive = { id: string; number: string; name: string; waiting: { linkedid; callerNumber; callerName?; since }[]; members: { ext; paused; state; callsTaken; lastCall? }[] };
type ParkedLive = { slot: string; linkedid: string; callerNumber: string; callerName?: string; since: string; parkedBy?: string };
type MwiLive = Record<string /*ext*/, { new: number; old: number }>;
```

Initial load on connect (use `actionList`):

| Data | AMI action | Fields used |
|---|---|---|
| Extension states | `ExtensionStateList` | `Exten`, `Context` (= `sp-local-numbers`), `Status` |
| Contacts | `PJSIPShowContacts` | `Endpoint`/`EndpointName`, `Uri`, `UserAgent`, `Status`, `RoundtripUsec` |
| Trunk registrations | `PJSIPShowRegistrationsOutbound` | `OutboundRegistrationDetail`: `ObjectName` (`trunk-{id}-reg`), `Status` (`Registered`, `Rejected`, `Unregistered`, `Stopped`). **The reply also has `AuthDetail` items with the trunk password in clear text: never log it.** |
| Trunk reachability | `PJSIPShowEndpoint` `trunk-{id}` per trunk | `ContactStatusDetail` `Status`, `RoundtripUsec`. Static (`contact =`) AOR contacts are **not** listed by `PJSIPShowContacts` (verified on 24.0.0-rc2) |
| Channels | `CoreShowChannels` | `Channel`, `Uniqueid`, `Linkedid`, `ChannelStateDesc`, `CallerIDNum`, `ConnectedLineNum`, `Application`, `Exten`, `Context` |
| Queues | `QueueStatus` | `QueueParams`, `QueueMember`, `QueueEntry` events |
| Parking | `ParkedCalls` | `ParkingSpace`, `ParkeeLinkedid`, `ParkeeCallerIDNum` |
| MWI | `MailboxCount` per mailbox | `NewMessages`, `OldMessages` |

Events to handle (`live/handlers.ts`):

| Event | Effect |
|---|---|
| `ExtensionStatus` | update `ExtensionLive.state` (Status: 0 idle, 1 inuse, 2 busy, 4 unavailable, 8 ringing, 9 ringinuse, 16 onhold) |
| `ContactStatus` | add/update/remove contact (ContactStatus: Created, Reachable, Unreachable, Removed, Updated) |
| `Registry` | re-read `PJSIPShowRegistrationsOutbound`. `Username`/`Domain` are the client/server URIs, which two sub-accounts on one server share, so they can't name the trunk (verified) |
| `ContactStatus` with `AOR` `trunk-{id}` | trunk `reachable` (qualify) |
| `Newchannel`, `Newstate`, `NewCallerid`, `NewConnectedLine`, `DialBegin`, `DialEnd`, `BridgeEnter`, `BridgeLeave`, `Hold`, `Unhold`, `Hangup` | maintain `ActiveCall` grouped by `Linkedid`. When the last channel of a linkedid hangs up, drop the call and schedule CDR aggregation (§5.4) for 5 s later |
| `VarSet` with `Variable` in (`SP_DID`, `SP_DIRECTION`, `SP_REC`, `SP_TARGET`) | enrich `ActiveCall` (needs `eventfilter` or `read=all`; fine on localhost) |
| `QueueCallerJoin` / `QueueCallerLeave` / `QueueCallerAbandon` / `QueueMemberStatus` / `QueueMemberPause` / `AgentConnect` / `AgentComplete` | `QueueLive` |
| `ParkedCall` / `UnParkedCall` / `ParkedCallTimeOut` / `ParkedCallGiveUp` | `ParkedLive` |
| `MessageWaiting` | `MwiLive` (Mailbox `101@default`) |
| `UserEvent` `SpToggle` | §5.3 |
| `UserEvent` `SpEmergency` | §5.3 |
| `Cdr` | §5.4 |

Mapping channel name → extension: regex `^PJSIP/(\d+)(?:-web)?-[0-9a-f]+$`. Local
channels `Local/101@sp-rg-member-...` also count as 101.
Trunk channel: `^PJSIP/trunk-([0-9a-f-]{36})-`.

As built (M7-T4): calls live in `live/calls.ts` (`CallTracker`). DialBegin/DialEnd aren't needed:
the channel events carry everything. A call's channels are ordered by creation (Uniqueid seq),
so `channels[0]` is the caller. State, first match wins: hold, voicemail (app `VoiceMail`), ivr
(`BackGround`/`WaitExten`/`Read`), queued, parked, talking (2+ channels bridged and Up), else
ringing. `answeredAt` is the first time 2 channels are bridged; on a reload, `startedAt` is
`now - Duration`. Calls go to admins
only for now; a user's own calls are added when a user page shows them.

As built (M8-T1): queues live in `live/queues.ts` (`QueueTracker`), loaded from `QueueStatus` on
connect and after every config apply (QueueStatus errors while app_queue has no queues). Member state
is the `Status` device state (1 idle, 2 in use, 3 busy, 6 ringing, 7 ringinuse, 8 on hold, else
unavailable). Every snapshot has `queues`; a user's holds only the queues they are an agent of, and a
`queue.updated` for a queue they aren't in reaches them as `queue.removed`.

As built (M8-T2): parked calls live in `live/parking.ts` (`ParkingTracker`), loaded from `ParkedCalls`
and changed by `ParkedCall` / `UnParkedCall` / `ParkedCallTimeOut` / `ParkedCallGiveUp`; deltas are
`parked.updated` and `parked.removed` (`{slot}`), for everyone. `parkedBy` comes from
`ParkerDialString` (`PJSIP/101`). A blind transfer to 700 parks without running `Park()` in the
dialplan, so a call's `parked` state comes from those events (by `ParkeeLinkedid`), not from the
channel's application; the phone that picks it up runs `ParkedCall()` while talking (verified).

### 5.2 Live WebSocket (`GET /api/live`)

- Auth: session cookie (the browser sends it automatically). Close code 4401 when unauthenticated.
  As built (M11-T8): an `Origin` whose host isn't the request's `Host` closes with 4403 (no Origin:
  not a browser, allowed); every 30 s each socket's session is checked again (without sliding its
  expiry), and a logout, deactivation, role change or forced password change closes it with 4401.
- Server → client messages are JSON `{ "type": string, "data": any }`.
- On connect: one `snapshot` message containing the live state the user may see, then deltas.
- Visibility:
  - **admin**: everything.
  - **user**: all `ExtensionLive` without `contacts` (presence/BLF for the whole company),
    active calls where their extension is in `extensions`, MWI for their own mailbox,
    queues they are a member of, all parked calls.
- Delta types: `extension.updated`, `trunk.updated`, `call.updated`, `call.removed` (`{linkedid}`),
  `queue.updated`, `parked.updated`, `mwi.updated`, `voicemail.new`, `sms.received`,
  `emergency.call` (admins + emergency notify users), `system.configApplied`,
  `system.restartRequired`, `ami.status` (`{connected: boolean}`).
- Batch deltas: send at most once every 250 ms per client (merge `*.updated` for the same key).
- Ping every 30 s and drop clients that don't pong.

### 5.3 Dialplan → api events

`SpToggle` fields: `Key` (DND | CFU | CFB | CFNA | QPAUSE | TCOVR), `Ext`, `Queue`, `Id`, `Value`.
- DND / CFU / CFB / CFNA: update `user_runtime_state` for that extension.
  For CFU/CFB/CFNA with an external number, run `canDial(ext.outbound_class, number)`
  (uses the outbound routes' patterns and required classes). If not allowed:
  `DBDel` the key over AMI, keep the DB value null, write an audit entry
  `forward_rejected`, and push a `toast` to that user's WS clients.
- QPAUSE: update `queue_member_state`.
- TCOVR: update `time_conditions.override_state` (`auto` → null).
- Always broadcast the matching live delta.

`SpEmergency` fields: `Ext`, `CallerId`, `Dialed`.
1. Insert `emergency_events` with `location` from `extensions.emergency_location`.
2. Email every address in `emergency.notifyEmails`: subject
   `EMERGENCY: 911 dialed from ext {ext} ({name})`, body with time, extension,
   name, location, caller ID sent. Send immediately; don't wait for a queue.
3. For each `emergency.notifyExtensionIds`: AMI `Originate` with
   `Channel: PJSIP/<notifyExt>`, `Context: sp-emergency-alert`, `Exten: <ext>`,
   `Priority: 1`, `CallerID: "EMERGENCY 911" <<ext>>`, `Async: true`.
4. Broadcast `emergency.call`. Fire webhook `emergency.call`.
5. Record the outcome of every notification in `emergency_events.notified`.

### 5.4 CDR ingestion and call aggregation (`services/cdr.ts`)

- On each `Cdr` event: insert the raw row into `cdr` (fields map 1:1, `raw` = whole message).
  Variables from `cdr_manager.conf` `[mappings]` arrive as lowercase keys `sp_did`, `sp_direction`, `sp_recording`.
- `aggregateCall(linkedid)` runs 5 s after the last hangup (and again from the
  nightly job for any linkedid in `cdr` without a `calls` row):
  - `rows` = all cdr rows for the linkedid, ordered by `start_at`.
  - **direction**: first non-empty `sp_direction`; else `inbound` if any `channel`
    is a trunk channel; else `outbound` if any `dstchannel` is a trunk channel; else `internal`.
  - **from**: `src` + name parsed from `clid` of the first row.
  - **to**: inbound → the DID (`sp_did`); otherwise `dst` of the first row.
  - **rang**: every extension parsed from any `dstchannel`.
  - **answered_by**: the extension in `dstchannel` of the first row with `disposition = 'ANSWERED'` and an extension dstchannel.
    For outbound: answered if the trunk leg is ANSWERED.
  - **status**, checked in this order: `answered` if answered_by is set (or the outbound trunk leg was answered);
    `voicemail` if any row has `lastapp = 'VoiceMail'` and `billsec > 0`;
    `abandoned` if any row has `lastapp = 'Queue'`; `busy` if any row's disposition is `BUSY`;
    `failed` if any row's disposition is `FAILED` or `CONGESTION`; otherwise `missed`.
  - **talk_seconds**: max `billsec` of answered extension/trunk rows.
  - **recording**: if any `sp_recording` is set and the file exists → create
    `recordings` (size via `fs.stat`, duration via `ffprobe`) and link it.
  - Insert `calls` + `call_extensions`, then fire webhook `call.ended`.
- This is a heuristic. In M7, record real AMI Cdr events from test calls
  (inbound to user, inbound to ring group, IVR → voicemail, queue abandon,
  outbound, transfer, park) into `test/fixtures/cdr/*.json` and write a test per scenario.
  M8 added `queue-answered`, `queue-abandoned`, `queue-timeout-voicemail` and `park-pickup` (the
  call counts as answered by whoever parked it; the one who picked it up is in `rang`).

As built (M7-T1):
- `apps/api/test/asterisk/cdr-record.ts` records 8 scenarios against our config, the fake
  provider and baresip phones: internal answered / to voicemail / to an unavailable phone, inbound
  to a user / ring group / IVR timeout → voicemail, outbound answered, blind transfer. Queue
  abandon and park come with M8. `test/cdr.test.ts` checks each one.
- `cdr_manager.conf` [mappings] read **CDR variables**, not channel variables: the dialplan sets
  `CDR(SP_DID)` in `sp-inbound` and `CDR(SP_DIRECTION)` at the trunk entry, in outbound routes and
  in emergency calls. `linkedid` must be mapped too (01 §3.15); times are UTC (`usegmtime`).
- **rang** also includes the owner of the mailbox a `VoiceMail` leg recorded into (DND, IVR →
  voicemail): the call was for them, so it shows in their history and as missed (M7-T2).
- **from** is the caller's extension when the first leg is a phone (not the caller ID it sends
  outside); otherwise `src`. An outbound call has no `answered_by` (no extension answered).
- **recording** (M7-T3): `sp-sub-record` sets `CDR(SP_REC)`; the file (relative, under
  `RECORDINGS_DIR`) becomes a `recordings` row (size, ffprobe length) linked to the call.
  `/api/recordings/:id/audio` serves it to admins and to users whose extension made or answered
  the call (`call_extensions` role `caller` or `answered`), not to a phone that only rang (08 §7
  #3); `/api/me/calls` shows such a call without its `recordingId`.
  Retention runs once a day (and at start) in the same day-change check as the nightly regenerate.
- Aggregation runs 5 s after a linkedid's last Cdr event; on every AMI connect, linkedids older
  than a minute without a `calls` row are aggregated (instead of the nightly job).

### 5.5 AstDB sync (`services/astdb.ts`)

On every AMI connect, PostgreSQL wins:
1. `DBDelTree Family: SP` (wipes our keys).
2. For each extension: `DBPut SP DND/<ext> 1` if dnd; CFU/CFB/CFNA if set.
3. For each blocked number: `DBPut SP BLOCK/<number> 1`.
4. For each paused queue member: `DBPut SP QPAUSE/<queue>/<ext> 1`.
5. For each time condition with `override_state`: `DBPut SP TCOVR/<id> <state>`.

Keep one function per key type (`setDnd(ext, on)`, etc.). Routes call these after writing PostgreSQL.
M6-T4 implements the sync and `setTcOverride`; DND/forwards (M6-T7), blocks (M6-T8) and queue
pauses (M8-T1) add their keys. `queue reload all` (and rollback) unpause everyone, so the generator
sends `QueuePause` for every paused agent right after it (03 §1 step 9); on connect that follows the
forced apply.

### 5.6 Voicemail watcher (`services/voicemail.ts`)

- **When to look:** rescan one mailbox's `INBOX`, `Old` and `Urgent` folders on every AMI
  `MessageWaiting` event (`Mailbox: 101@default`), and every mailbox on each AMI (re)connect.
  Asterisk raises it after a message is saved, listened to, moved or deleted, from a phone or
  from us. No file watcher: inotify is unreliable on bind mounts, and this needs no dependency.
  Scans of one mailbox run one at a time. (M4-T2; the spec first said chokidar.)
- Parse each `msgNNNN.txt`: INI-like, section `[message]`, keys `callerid`, `origtime` (epoch),
  `duration`, `msg_id`, `flag`. `callerid` looks like `"Name" <13125551234>`. A file without
  `msg_id` is still being written: skip it, the next event picks it up.
- Upsert `voicemail_messages` by `msg_id` (update `folder`, `file_path`; `file_path` is relative
  to the spool, e.g. `default/101/INBOX/msg0000.wav`, because Asterisk renumbers files).
  If it's new and not in `Old`: send `voicemail.new` over the live WebSocket (only to the owner,
  not to admins; webhook in M11-T5) and, if the user has `voicemail_email`, an email address and
  SMTP is configured, send an email (§10) with the `.wav` attached if `voicemail_attach_audio`.
  Then set `emailed_at`. If `voicemail_delete_after_email` **and** the audio was attached, remove
  it with AMI `VoicemailRemove` and set `deleted_at`. A failed email is logged; the message stays.
- Rows whose `msg_id` is no longer in any folder get `deleted_at`.
- **API operations** (`markRead` = INBOX→Old, `delete`): use the AMI actions `VoicemailMove`
  (`Context, Mailbox, Folder, ID, ToFolder`) and `VoicemailRemove` (`Context, Mailbox, Folder, ID`),
  where `ID` is the `msg_id`. They exist in Asterisk 24 (checked on 24.0.0-rc2), renumber the
  folder and update MWI, so there is no renumbering code.
- Greetings: `PUT /api/me/greetings/:kind` (kind: `unavail` | `busy` | `greet` (name) | `temp`)
  converts the upload to `/var/spool/asterisk/voicemail/default/<ext>/<kind>.wav`
  (8 kHz mono PCM). `DELETE` removes it.

## 6. Media (`media/audio.ts`)

- Accept uploads: wav, mp3, ogg, opus, m4a, flac. Max 20 MB. Max 15 minutes.
- Convert with ffmpeg (spawn, no shell):
  - `ffmpeg -nostdin -y -i <in> -ac 1 -ar 8000 -c:a pcm_s16le <out>.wav`
  - `ffmpeg -nostdin -y -i <in> -ac 1 -ar 16000 -c:a g722 <out>.g722` (HD copy that Asterisk picks for G.722 calls)
  - Loudness normalize with `-af loudnorm=I=-16:TP=-1.5:LRA=11` on both.
- Duration: `ffprobe -v error -show_entries format=duration -of csv=p=0 <out>.wav`.
- Prompts: `/var/lib/asterisk/sounds/custom/<id>.{wav,g722}` → `asterisk_name = custom/<id>`.
- MOH: `/var/lib/asterisk/moh/<className>/<id>.wav` (wav only). After any MOH change, call `generator.requestApply`.
  As built (M8-T5): the folder is `MOH_DIR` (default `/var/lib/asterisk/moh`). Adding or removing a
  file changes no config unless it's the class's first or last, so the route also sends `moh reload`.
- Deleting a sound referenced by an IVR/announcement/settings → 409 with references.
- Optional TTS (M12): `POST /api/sounds/tts {name, text, voice}` runs Piper (binary
  and voice models in the api image under `/opt/piper`), then the same conversion.

## 7. REST API

### 7.1 Conventions
- Base path `/api`. JSON in, JSON out. Dates are ISO 8601 UTC strings.
- Every request body and query is validated with zod schemas from `packages/shared`.
- Errors: HTTP status + `{ "error": { "code": "snake_case", "message": "Human text", "details": {} } }`.
  Codes: `validation_failed` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404),
  `conflict` (409, e.g. number taken, in use), `rate_limited` (429), `internal` (500).
- Lists: `?limit=50&cursor=<opaque>` → `{ items: [], nextCursor: string | null }`.
- Every create/update/delete of config objects: (1) writes PostgreSQL in a transaction, (2) writes `audit_log`
  with a secret-redacted diff, (3) calls `generator.requestApply('api-change')`.
- Secrets never come back in responses. Use `hasPassword: true`. Separate explicit endpoints reveal them.

### 7.2 Number allocation (`services/numbering.ts`)
`assertNumberAvailable(number, kind, excludeId?)`:
1. Digits only, 3–6 chars.
2. Not in the reserved list (00 §7).
3. Inside the configured range for `kind`.
4. Not used by any of: extensions, ring_groups, queues, ivrs, conferences, paging_groups, parking 700–720.
Throw `conflict` naming the current owner. `GET /api/numbering/next?kind=user` returns the lowest free number.

### 7.3 Endpoints

Auth & self:
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | public | §2.2 |
| POST | `/api/auth/logout` | auth | |
| GET | `/api/auth/me` | auth | user + extension summary |
| POST | `/api/auth/change-password` | auth | `{currentPassword, newPassword}` |
| GET | `/api/me` | user | extension settings, runtime state |
| PATCH | `/api/me` | user | `{dnd?, cfu?, cfb?, cfna?, voicemailEmail?, voicemailAttachAudio?, voicemailDeleteAfterEmail?, voicemailPin?}` → DB, then AstDB |
| GET | `/api/me/softphone-qr` | user | `{url, qr, expiresAt}`: Linphone setup link and its QR (PNG data URL), 24 h (07 §5) |
| GET | `/api/me/webrtc` | user | `{ wsUrl: "wss://<host>/ws", sipUri: "sip:101-web@<host>", authUser: "101-web", password, displayName, iceServers: [...] }` |
| GET | `/api/me/calls` | user | own call history (via `call_extensions`) |
| GET | `/api/me/reports/summary?from&to` | user | `/api/reports/summary` of the calls that rang or were answered by me; `answered` and talk time are the ones I picked up |
| POST | `/api/me/spam-reports` {callId, reason} | user | Report spam on an outside call that rang me; the number comes from the call. 404 not my call, 400 hidden number, 409 already blocked or already reported by me |
| GET | `/api/me/voicemail` | user | list |
| GET | `/api/me/voicemail/:id/audio` | user | streams the wav (`Content-Type: audio/wav`, supports Range) |
| PATCH | `/api/me/voicemail/:id` | user | `{folder: 'Old'|'INBOX'}` |
| DELETE | `/api/me/voicemail/:id` | user | |
| GET | `/api/me/greetings` | user | `{unavail, busy, greet, temp}`: which are recorded |
| GET | `/api/me/greetings/:kind/audio` | user | the wav |
| PUT/DELETE | `/api/me/greetings/:kind` | user | PUT body is the raw audio (a MediaRecorder Blob or a picked File, any `Content-Type`, max 20 MB), not multipart: no extra dependency. ffmpeg converts it (§6) |
| GET | `/api/me/voicemail/:id/audio?download=1` | user | same, as an attachment |
| GET | `/api/me/caller-check?number=` | user | the spam check for a caller ringing one of my extensions now, else `{check: null}` (14 §5.1, §9.4) |
| GET/POST/PATCH/DELETE | `/api/me/contacts[/:id]` | user | my contacts; GET lists the company's too (11 §3). `POST /import`, `POST /share`, `GET /shares`, `POST /shares/accept\|deny` (11 §2.1, §3.1), `POST /copy-to-contrack` (11 §6.2) |
| POST | `/api/me/queues/:id/pause`, `/unpause` | user | log out of / in to a queue I'm an agent of (Home, 05 §4), same as `*45<queue>` |
| POST | `/api/me/click-to-call` | user | `{number}` → AMI `Originate Channel: PJSIP/<ext>, Context: sp-from-ext, Exten: <normalized>, Priority: 1, CallerID: "<number>" <<ext>>, Async: true`. The user's phone rings first, then the call goes out |

Admin resources (all `requireAdmin`; standard CRUD = `GET /x`, `POST /x`, `GET /x/:id`, `PATCH /x/:id`, `DELETE /x/:id`):
| Resource | Extra endpoints |
|---|---|
| `/api/users` | `POST /:id/reset-password` (sets a temp password, `must_change_password`) |
| `/api/extensions` | `POST /:id/regenerate-sip-password`, `GET /:id/sip-credentials` (audited), `GET /:id/softphone-qr` (07 §5) |
| `/api/trunks` | `POST /:id/test` (live registration status + OPTIONS RTT), `POST /:id/import-dids` (voip.ms API, 06 §5). As built (M9-T1): `GET /:id/voipms-servers` → `{servers: [hostname]}`; `GET /:id/import-dids` → the account's numbers `{number, description, smsEnabled, added}`; `POST /:id/import-dids {numbers}` adds only numbers voip.ms lists and that aren't added yet → `{added}`. 400 without API credentials on the trunk, 502 `provider_error` with voip.ms's reason (never the request URL). `VOIPMS_API_URL` overrides the endpoint for tests |
| `/api/dids` | |
| `/api/outbound-routes` | `POST /reorder {ids: []}`, `POST /test {extensionId, number}` → which route/trunk would be used, or why it's denied |
| `/api/ring-groups` | members are set via `members: [{extensionId}]` in POST/PATCH |
| `/api/queues` | `GET /:id/stats?from&to`, `POST /:id/members/:extId/pause`, `.../unpause`. Agents are sent as `members: [{extensionId, penalty}]`. Stats (company-time-zone days, default today): `{offered, answered, abandoned, timedOut, avgWaitSeconds, withinSlaPercent}` from `queue_calls` (02), which `services/queuestats.ts` fills from app_queue's AMI events and `SpQueueExit`. `withinSlaPercent` (service level) = answered within `sla_seconds` ÷ callers who left the queue, minus those who hung up within `sla_seconds`; timed out and turned away count as missed, callers still waiting aren't counted; `null` when nobody counts |
| `/api/ivrs` | options sent as `options: [{digit, destination}]` |
| `/api/time-conditions` | `POST /:id/override {state: 'open'|'closed'|'auto'}`, `GET /:id/status` (open/closed now) |
| `/api/holidays` | `POST /import-us-federal {year}` (generates the list in code, no network) |
| `/api/announcements` | |
| `/api/conferences` | |
| `/api/paging-groups` | members are set via `memberIds: [uuid]` in POST/PATCH (no order). Not a destination, so delete never returns 409 |
| `/api/sounds` | upload is `POST /api/sounds?name=&filename=` with the raw file as the body (like greetings, no multipart), `GET /:id/audio`, `PATCH /:id {name}`, `DELETE /:id` (409 with `usedBy`: IVR greeting/invalid sound, announcements, the recording notice), `POST /tts` (M12). M6 lists prompts only; MOH classes and files come with M8 |
| `/api/moh-classes` | `POST {name}` (slug, not `default`), `DELETE /:id` (409 with `usedBy` while an extension or queue uses it), `POST /:id/files?name=&filename=` (raw file body, like sounds), `GET /:id/files/:fileId/audio`, `DELETE /:id/files/:fileId`. No rename: the name is the folder and is stored on extensions and queues. Extensions and queues may only pick `default` or an existing class (400) |
| `/api/devices` | `GET /:id/config-preview` (rendered provisioning file, passwords masked). As built (M10-T1): body `{mac (any format), vendor, model, label, extensionId}`; the DTO carries `provisioningUrl` and the `provisioningPassword` (admins type it into the phone); MAC taken → 409; preview of a generic phone → 400 |
| `/api/blocked-numbers` | |
| `/api/spam-reports` | GET (with the reporter's name) and DELETE (Dismiss). Blocking a number deletes its reports |
| `/api/contacts` | company phonebook; `POST /import` CSV (`name,company,email,label1,number1,...`) or vCard (11 §3.1) |
| `/api/webhooks` | `POST /:id/test`, `GET /:id/deliveries` |
| `/api/api-tokens` | POST returns the token once |

Reports, history, system:
| Method | Path | Notes |
|---|---|---|
| GET | `/api/calls` | filters: `from`, `to`, `direction`, `status`, `extensionId`, `didId`, `q` (number search) |
| GET | `/api/calls/export.csv` | same filters |
| GET | `/api/recordings`, `/api/recordings/:id/audio`, DELETE `/api/recordings/:id` | |
| GET | `/api/reports/summary?from&to` | totals per day, per direction, missed count, average talk time |
| GET | `/api/reports/queues?from&to` | per queue: offered, answered, abandoned, avg wait, % within SLA |

As built (M11-T6): `routes/reports.ts`. `from`/`to` are company-time-zone days, inclusive; without them the last 30 days, at most a year (400). The summary is `{from, to, days: [{date, inbound, outbound, internal, missed}], totals: {calls, missed, avgTalkSeconds}, hours}`: every day in the range (empty ones too), missed = missed + voicemail + abandoned, average talk over answered calls, and `hours[weekday][hour]` with 0 = Sunday. The queue rows are `queueStats` (the queue page's numbers) for each queue, with `id, number, name, slaSeconds`.

| GET | `/api/audit-log` | |
| GET/PATCH | `/api/settings` | whole settings object; PATCH merges known keys only. `smtp` comes back as `{host, port, secure, username, from, hasPassword}` and is written with an optional `password` (empty keeps the stored one). `system.*`, `sms.webhookToken` and `setup.completed` are read-only. References (DIDs, extensions, destinations) are checked, and a transport a trunk uses can't be turned off |
| POST | `/api/settings/smtp/test` | `{to}` sends a test email |
| POST | `/api/settings/spam/ftc/sync` | Download now: the FTC download starts at the next minute (14 §9.3) |
| POST | `/api/settings/spam/ipqs/test`, `/api/settings/spam/ftc/test` | `{key?}`: the typed key, else the saved one; `{ok, detail}` or `{ok: false, error}` (14 §7.1) |
| POST | `/api/settings/emergency/test` | runs 04 §5.3 steps 2–4 with `TEST` in front (email, ring-out, banner); records nothing and dials nothing (06 §6.5). Returns `{notified}` |
| GET | `/api/system/warnings` | `{items: [{code, message, link, dismissable?}]}` for the dashboard banner: `restart_required`, `e911_cid_missing` (a trunk exists, no default E911 caller ID), `e911_address_unconfirmed` (that DID has no `e911_address`), `smtp_missing`, `tls_cert` (TLS on and the cert missing or expiring within 14 days, M11-T2), `backup_old` (backups on and today's not made yet though the job had its chance, M11-T3), `directory_check` (12 §4.2, §4.5: the directory unreachable at a sign-in or by `directoryCheck`, or that job refusing to disable most people), `spam_quota` (14 §3, dismissable). "Trunk down" comes from live state in the browser |
| POST | `/api/system/warnings/spam_quota/dismiss` | hides `spam_quota` until IPQualityScore's credits run out again (14 §3) |
| POST | `/api/settings/network/detect-public-ip` | |
| GET | `/api/system/status` | `{ db: ok, ami: connected, asteriskVersion, uptime, trunks: [...], disk: {free, total}, restartRequired, lastGeneratorRun }` |
| GET | `/api/system/tls` | the SIP TLS certificate in `TLS_DIR`: `{ok: true, subject, names, notAfter}` or `{ok: false, error}` (M11-T2) |
| GET | `/api/system/generated-files` | names + contents of generated files, **passwords masked** (debug view) |
| POST | `/api/system/config/apply` | force regenerate |
| POST | `/api/system/config/rollback` | |
| POST | `/api/system/asterisk/restart?now=false` | |
| GET | `/api/system/asterisk/cli?cmd=` | **allowlist only**: `pjsip show endpoints`, `pjsip show registrations`, `pjsip show contacts`, `core show channels`, `queue show`, `dialplan show <sp-context>`. Never pass arbitrary commands |
| POST | `/api/system/backups` | create one now |
| GET | `/api/system/backups`, `/api/system/backups/:name/download` | |
| GET/POST | `/api/setup/status`, `/api/setup/complete` | first-run wizard (05 §2.1) |
| GET | `/api/live` | WebSocket (§5.2) |
| POST | `/api/live/calls/:linkedid/hangup` | admin |
| POST | `/api/live/calls/:linkedid/transfer` | admin `{target}` → AMI `Redirect` of the external party's channel to `sp-local-numbers,<target>,1` |
| POST | `/api/live/calls/:linkedid/spy` | admin `{mode: 'listen'|'whisper'|'barge'}` → Originate to admin's ext running `ChanSpy(<channel>,q{''|w|B})` (M10). As built (M10-T4): rings the admin's **desk** phone (`PJSIP/<ext>`, 409 if it isn't connected; 400 without an extension); spies on the call's first user leg (`PJSIP/<n>` or `-web`, not the admin's own, never a trunk or Local channel), which for an inbound or queue call is the agent; options `qE`, `qEw`, `qEB` (`E`: the spy leg ends with the call). Audited as `call_spy`. The spy leg shows on the dashboard as its own call ("Listen 101"); hanging it up stops listening |
| GET | `/healthz` | unauthenticated; 200 if DB ok, AMI connected, else 503 with JSON reasons |

SMS (06 §5): `GET /api/sms/threads`, `GET /api/sms/threads/:didId/:remoteNumber`,
`POST /api/sms/send {didId, to, body}`, `POST /api/sms/threads/:didId/:remote/read`.
Users only see DIDs they're assigned in `did_sms_users`. Admins see all.

Provisioning and inbound hooks (outside `/api`, no session):
- `GET /prov/...`: see `07-provisioning.md`.
- `GET|POST /hooks/voipms/sms/:token`: see `06-voipms.md` §5.

## 8. Background jobs (`jobs/`, using croner, times in `general.timezone`)

| Job | Schedule | Does |
|---|---|---|
| `nightlyRegenerate` | 00:05 daily | `generator.apply({trigger:'nightly', force:true})` (holidays roll over), aggregate orphan CDRs |
| `retentionCleanup` | 02:00 daily | delete recordings older than `recordings.retentionDays` (file + row), voicemail older than `voicemail.retentionDays` if > 0, sessions past expiry, webhook_deliveries older than 30 days, expired `spam_lookups` (14 §4) |
| `backup` | `backup.time` daily if enabled | §8.1 |
| `publicIpWatch` | every 5 min if enabled | detect IP; if changed: update settings, apply, set restartRequired, email admins |
| `webhookDelivery` | every 10 s | send pending deliveries (§9) |
| `trunkWatch` | every 60 s | if a trunk is unregistered for more than 5 min → email admins once per outage |
| `diskWatch` | hourly | if free disk < 10% → email admins once a day |
| `contactsWarm` | every 5 min, Contrack mode | refresh the company's and each connected person's Contrack book, so a ringing phone's caller-name lookup (11 §6.1) finds them |
| `contrackLog` | every 60 s, Contrack mode | calls ended over 1 min ago (and within 2 days) of people logging calls: one `call` interaction on the matching contact's Contrack timeline (11 §4.4) |
| `callReports` | every 60 s | each user whose call report period (05 §4) ended over 5 min ago and isn't reported yet: email their calls of that period (by hang-up time) if there were any; `extensions.call_report_sent_at` = the period's end. Changing the schedule sets it to now, so the first report is the next period's |
| `spamFtcSync` | every 60 s, when due or under way | the FTC complaint download, 15 pages a minute (14 §2.2, §9.3) |
| `spamQuotaCheck` | every 6 hours, while IPQualityScore is paused | ask its Credit Usage API; credits back → resume (14 §3) |

Jobs must never overlap with themselves (use a running flag).

As built (M11-T4): `jobs.ts`, one setInterval a minute instead of croner (every schedule above is
whole minutes). Each job has a running flag; an error is logged, not fatal.
- `nightlyRegenerate` and `retentionCleanup` run when the date in `general.timezone` changes and
  at start, not at 00:05 / 02:00. Retention waits for AMI: voicemail is removed with
  `VoicemailRemove`, so Asterisk renumbers the folder and updates MWI. It also deletes recordings,
  expired sessions and webhook deliveries older than 30 days.
- `publicIpWatch` asks api.ipify.org (then ifconfig.me), only when the setting is on (Settings →
  Network). A changed IP is saved, audited, applied (which sets `restartRequired`; the job doesn't
  restart Asterisk, that drops calls) and emailed.
- `trunkWatch` only knows registering trunks (IP-auth trunks are always `unknown`): rejected or
  unregistered for 5 minutes in a row → one email; registered again ends the outage. Skipped while
  AMI is down. No "back up" email.
- `diskWatch` checks the filesystem of `RECORDINGS_DIR` (`statfs`).
- Admin emails go to every active admin; the texts are in `jobs.ts`, not `mail.ts`. A failed daily
  backup emails them too (08 §3.2). Email not set up: logged, nothing else.

### 8.1 Backups
Folder `/var/lib/selfphoneng/backups/selfphoneng-YYYYMMDD-HHMMSS.tar.gz` containing:
`db.sql` (`pg_dump --no-owner`), `voicemail/`, `sounds-custom/`, `moh/`,
`manifest.json`. Do **not** include `asterisk-generated/`: it holds plaintext SIP passwords and is rebuilt from the DB on start.
`manifest.json` is `{version, createdAt, includesRecordings}`. The backup file mode is 0600. Recordings are optional
(setting `backup.includeRecordings`, default false, because they get large). Keep the newest `backup.keep` backups.
Restore is a CLI script only: `scripts/restore.sh <file>`. It stops api+asterisk, restores the DB and files, and starts them again.
`APP_SECRET` must be the same as when the backup was made. The script warns about this.

As built (M11-T3):
- `services/backup.ts`: `pg_dump --no-owner` and GNU tar (both in the api image), folders renamed
  in the archive to their `data/` names (`voicemail`, `sounds-custom`, `moh`, `recordings`) so
  restore untars straight into `data/`. Written as `.<name>.tmp`, then renamed. `BACKUPS_DIR`.
- `manifest.json` = `{version: 1 (the backup format), createdAt, includesRecordings, folders,
  secretCheck}`. `secretCheck` is the first 16 hex of `sha256("selfphoneng-backup:" + APP_SECRET)`:
  restore.sh computes the same from `.env` and **refuses** (not just warns) when they differ.
- Restore runs from the install folder: asks for `yes`, stops api + asterisk, drops and recreates
  the database, loads `db.sql`, replaces only the folders the backup has (owner `APP_UID`), starts
  them again. AstDB and the generated config come back from the database when the api starts.
- Schedule: the api's once-a-minute timer (no croner yet) runs it when it's past `backup.time` in
  `general.timezone` and no backup from today exists, so a fresh install backs up within a minute
  of starting. One try a day; a missed one shows as the `backup_old` dashboard warning.
- Tested on two throwaway Docker hosts (`scripts/e2e/m11-t3.mjs`): back up on one, restore on the
  other.

## 9. Webhooks

Events: `call.started`, `call.answered`, `call.ended`, `voicemail.new`, `sms.received`,
`sms.sent`, `emergency.call`, `trunk.registration_changed`, `extension.registration_changed`.

- Payload: `{ "id": "<uuid>", "event": "call.ended", "createdAt": "...", "data": {...} }`.
  `data` uses the same shapes as the REST API, except `voicemail.new` has no `transcript`: a
  webhook leaves the server and transcripts don't (10 §1, 08 §7 #6).
- Headers: `Content-Type: application/json`, `X-SelfPhoneNG-Event`,
  `X-SelfPhoneNG-Timestamp` (unix seconds),
  `X-SelfPhoneNG-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>`.
- Delivery: POST with 10 s timeout. A 2xx response means done. Otherwise retry after 1 m, 5 m, 30 m, 2 h, 12 h, then mark `failed`.
- Block private/loopback target IPs unless setting `webhooks.allowPrivate = true` (SSRF protection; homelab users can turn it on).

As built (M11-T5): `services/webhooks.ts`, `routes/integrations.ts`, Settings → Webhooks.
- Events come from the live state's messages (`watchWebhooks`): `call.started` (first time a
  call is seen, also for calls in progress when the api starts), `call.answered`, `call.ended`
  (the last ActiveCall + `endedAt`, not the CDR), `emergency.call`,
  `trunk.registration_changed` and `extension.registration_changed` (only on a change, with
  `previous` / `online`). `voicemail.new` (VoicemailDto + `extension`) is queued by the voicemail
  scan itself, for every mailbox: the live message only goes to the mailbox's user. `sms.*` can
  be picked but never fire until SMS is built (M9-T2).
- Each event becomes one `webhook_deliveries` row per enabled webhook that wants it; the
  `webhookDelivery` job sends up to 20 due rows every 10 s, in parallel. 6 tries in all, then
  `failed`. A webhook turned off keeps its pending rows until it's on again (or 30 days pass).
- The secret is 32 random bytes as hex, stored encrypted, shown to admins on the webhook.
- The private-address check is in the DNS lookup of the connection itself (node:http with a
  `lookup`), so DNS rebinding can't get past it; IP literals are checked before. Blocked: 0/8,
  10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 224/3, ::, ::1, fc00::/7, fe80::/10,
  ff00::/8 and IPv4-mapped forms of those. Redirects aren't followed.
- `POST /:id/test` sends `webhook.test` right away (not queued) and returns `{ok, status, error}`.

## 10. Email (`services/mail.ts`)

nodemailer transport from `settings.smtp`. Templates are plain TypeScript functions returning `{subject, text, html}`:
- **voicemail**: subject `New voicemail from {callerName or number} ({m:ss})`. Body: caller, number,
  received time in company timezone, duration, link `https://<host>/me/voicemail`.
  Attachment `voicemail-<date>.wav`.
- **emergency**: §5.3.
- **trunkDown**, **diskLow**, **publicIpChanged**, **passwordReset**.
If SMTP isn't configured, the UI shows a warning wherever email features are used.

## 11. Logging

pino JSON to stdout. `redact: ['*.password', '*.secret', '*.token', '*.pin', '*.Secret', 'req.headers.authorization', 'req.headers.cookie']`.
Log every apply (files changed, duration), AMI connect/disconnect, auth events, and outgoing webhook failures.
Never log SIP passwords, voicemail PINs, AMI login or the raw text of SMS messages (log ids and lengths only).
