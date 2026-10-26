# 13 — Mobile app (Android + iPhone)

Owner, 2026-10-26: our own app for the user portal, on both phones from one codebase. Why this
stack: [decision 0005](../decisions/0005-mobile-app.md).

## 1. What it is

- Repo: `git.dou.bet/spng/mobile` (AGPL-3.0), checked out at `mobile/` beside this repo. It has
  this repo as a git submodule for `@selfphoneng/shared` (types and zod schemas).
- Expo (React Native) + TypeScript, react-query and zustand, as the web client. Expo packages:
  expo-router (screens, and the `selfphoneng://` links), expo-camera (scanning the pairing QR),
  expo-secure-store (the device token), expo-device (the phone's name for the device list).
  Types from `@selfphoneng/shared` are `import type` only, so the app bundles none of this repo.
- **User portal only** (owner): calls, call history, voicemail, contacts, My settings. No admin
  screens; admins use the web panel, which works in a phone's browser.
- Calls: SIP.js + react-native-webrtc on the extension's `-web` endpoint (`GET /api/me/webrtc`),
  the same one the browser softphone uses (`max_contacts = 3`, so a browser and a phone fit). The
  extension needs the browser softphone turned on. Native call screen: expo-callkit-telecom
  (CallKit on iOS, Core-Telecom on Android); calls show in the phone's own recent calls (iOS
  Recents; Android `EXTRA_LOG_SELF_MANAGED_CALLS`).
- **No push in v1** (owner): the app rings only while it's open. The app and the admin guide say
  so, as 07 §5 does, and suggest forwarding unanswered calls to the mobile number.
- Built and sideloaded only for now (owner): an Android APK; iOS through ios-builder (macOS CI
  runner) with a free Apple ID re-sign. No store listings yet.

## 2. Pairing a phone

The app signs in by pairing, not with a password: the person is already signed in on the web, so
OpenID, LDAP and two-step sign-in all work without the app knowing about them.

1. My settings → **Mobile app** → **Pair a phone** (`POST /api/me/mobile-devices/pair`, a browser
   session only: 403 with any Bearer token). The api makes a one-time **pairing code**: 12 characters
   from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I), good for 10 minutes, stored as sha256.
   The answer: `{ code, server, link, qr, expiresAt }`, where `server = https://PUBLIC_HOSTNAME`,
   `link = selfphoneng://pair?server=<server>&code=<code>` and `qr` is a PNG data URL of `link`.
   The page shows the QR, and the server and code to type by hand.
2. The app scans it (or takes them typed) and calls `POST /api/mobile/pair`
   `{ code, name, platform: 'android' | 'ios' }` (public, `SLOW`: 10 a minute per IP; it has no
   token yet, so it sends `X-Requested-With: selfphoneng` like the web, 04 §2.2). Case and anything
   but letters and digits are dropped from the code before the check. A code
   that is unknown, used or expired → 404 `pair_code_invalid`; the user disabled since → the same.
   Success → `{ token, user: { name, email } }`: the **device token**, shown this once.
3. The app keeps the token in the phone's secure storage (expo-secure-store) and sends it as
   `Authorization: Bearer spm_<40 base62>` on every request.

Device tokens (`auth/devices.ts`):
- `requireAuth` takes `spm_` tokens before `sp_` API tokens; the request acts as the device's user
  (`req.mobileDeviceId` set). Unknown, removed, or the user disabled → 401. `lastUsedAt` is written
  on every request. `must_change_password` → 403 `password_change_required` as for API tokens.
- A phone is never an admin: `requireAuth` gives the request `role: 'user'` even for an admin's
  phone, so `requireAdmin` refuses it (403) and admin-only checks inside routes (recordings) don't
  pass. The app has no admin screens, and a lost phone shouldn't open the admin panel.
- A device token can't make pairing codes (a stolen phone can't make itself a spare).
- They don't expire (owner, 2026-10-26). They end when the person removes the device (on the web
  or Sign out in the app), and with every "sign out everywhere" (`deleteUserSessions`): the person
  changing their password (their current web session stays), an admin resetting their password or
  two-step sign-in, disabling them (also by the directory check), or deleting them.
- An OpenID user disabled at the provider but not here keeps their phone until an admin disables
  them on Users: the provider's session check (12 §3.5) only ends web sessions (owner: fine).

## 3. Data (`mobile_devices`, migration 0013)

The table is in 02 (`mobile_devices`).

A row is made by **Pair a phone** (code only) and filled by the app's pair call (token, code
cleared). Making a new code first deletes the user's rows that never paired.

## 4. API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/me/mobile-devices/pair` | browser session only. → `{ code, server, link, qr, expiresAt }` |
| POST | `/api/mobile/pair` | public, `SLOW`. `{ code, name, platform }` → `{ token, user }` |
| GET | `/api/me/mobile-devices` | paired devices: `{ id, name, platform, tokenPrefix, createdAt, lastUsedAt, current }` |
| DELETE | `/api/me/mobile-devices/:id` | removes one of your devices (the app's Sign out removes its own) |

Audit: `create` / `delete` on `mobile_device` (pairing code made, phone paired, device removed).

What the app uses besides these (all exist): `GET|PATCH /api/me`, `GET /api/me/webrtc`,
`GET /api/me/calls`, `GET|PATCH|DELETE /api/me/voicemail[/:id]`, `GET /api/me/voicemail/:id/audio`,
`GET /api/me/contacts`, `GET|PUT|DELETE /api/me/greetings/:kind`.

## 5. Order of work

| Task | Repo | What | Done when |
|---|---|---|---|
| MB1 | this | Decision 0005; this spec; migration 0013; device tokens in the guards; §4 routes; My settings → Mobile app (QR, code, device list, Remove) | `pnpm lint && typecheck && test` pass; pairing, device token, admin refusal and removal are tested. Done, see §5.1 |
| MB2 | this | The live socket (`GET /api/live`, 04 §5.2) takes a device token as `Authorization: Bearer` (React Native's WebSocket can send headers; browsers keep the cookie) | the app gets `voicemail` and presence events |
| MB3 | mobile | Expo skeleton, the submodule, pairing by QR, by hand and by `selfphoneng://pair` link, Sign out; Android APK builds; iOS steps for ios-builder (the tab bar comes with MB5, when there's a second screen) | the owner pairs an Android phone and an iPhone and sees their name and extension |
| MB4 | mobile | Calls: SIP.js + react-native-webrtc, register while open, dial pad, in and out, hold, mute, DTMF, speaker; native call screen; the "rings only while open" notice | a call each way with the PBX, on both phones, shown on the native call screen and in the phone's recent calls |
| MB5 | mobile | Call history (`/api/me/calls`), tap to call back | matches the web's Calls page |
| MB6 | mobile | Voicemail: list, play, mark heard, delete | as the web's Voicemail page |
| MB7 | mobile | Contacts: search, tap to call | as the web's Contacts page |
| MB8 | mobile | My settings: DND, forwarding, voicemail PIN and email, greetings | as the web's My settings |

### 5.1 As built: MB1

- `auth/devices.ts` (codes, tokens, `pairDevice`: the code is cleared in the same `update` that
  sets the token, so one code pairs one phone), `routes/mobile.ts`, migration 0013.
- My settings → **Mobile app**: Pair a phone shows the QR and the server and code; while it's up
  the page checks the list every 3 s and puts the code away when a new phone appears. Paired
  phones, with Remove.
- `apps/api/test/mobile.test.ts`. Not tried with a real phone yet: that's MB3.

### 5.2 As built: MB3 (mobile `6e4bc2b`)

- Expo SDK 58, React Native 0.88, Expo Router; app id `bet.dou.selfphoneng` (Android and iOS).
  `// TODO(spec)`: confirm the app id before any store listing (it can't change after).
- Screens: `pair` (scan, type, or a `selfphoneng://pair` link filled in and waiting for a tap, so
  a link someone sends can't pair the phone to their server unnoticed) and home (name, server,
  extension from `GET /api/me`, the rings-only-while-open notice, Sign out). Sign out deletes the
  device on the server, then forgets the token even if the server can't be reached.
- `npx expo export` bundles both platforms; a release APK (arm64) builds on Windows. That needed
  CMake 3.31 (`cmake.dir` in `android/local.properties`): the Android SDK's default CMake 3.22 has a
  `ninja` without long-path support, and React Native's codegen paths pass 260 characters.
- **Open:** the owner pairs a real Android phone and an iPhone (ios-builder needs a GitHub mirror
  of the mobile repo).

## 6. Later (not in MB1–MB8)

- Push, so the app rings in the background: FCM (Play build) and UnifiedPush (F-Droid build) on
  Android, Apple VoIP push through a relay the project runs (Apple's key belongs to the app's
  publisher, not to each PBX). The PBX sends the push and waits for the phone to register before
  ringing it. Needs a decision record (Play Services is closed source). Replaces M12's "Push
  gateway for mobile apps".
- App Store and Play listings (and AGPL vs App Store terms).
- TURN for strict mobile networks (`network.turn` already reaches `/api/me/webrtc`).
