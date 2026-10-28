# 05 — Web UI (apps/web)

One React app with two areas: **Admin** (`/admin/*`, admins only) and **My
Phone** (`/me/*`, every user, admins included). The browser softphone is part
of My Phone and stays docked on every `/me` page.

## 1. Global rules

- React 19 + TypeScript strict + Vite + react-router 7 + TanStack Query + Tailwind 4.
- A typed API client in `src/api/` generated from the zod schemas in
  `packages/shared` (write the wrappers by hand; no codegen tool). Every
  request sends `X-Requested-With: selfphoneng` and `credentials: 'same-origin'`.
- Forms validate with the **same zod schemas** as the API (`@hookform/resolvers/zod` + `react-hook-form`; add both to the allowed deps).
- Works at 360 px wide. Admin tables become stacked cards on small screens.
- Light and dark mode follow `prefers-color-scheme`, with a manual toggle stored in `localStorage` (wrapped in try/catch).
- Accessibility: every control has a label, focus is visible, the dialpad works from the keyboard, and the incoming-call dialog traps focus.
- Show phone numbers formatted (`(312) 555-1234`). Inputs accept any format and normalize on blur.
- Every destructive action uses a confirm dialog. Delete errors of type 409 show the "in use by" list from the API.
- Live data comes from the `/api/live` WebSocket (`src/live/`), stored in a small
  Zustand store (add `zustand` to the allowed deps). The client reconnects with backoff and shows a
  thin top banner "Reconnecting…" while disconnected.
- Never show a secret unless the user clicks "Reveal", which calls the explicit reveal endpoint.

## 2. Admin area

Left sidebar navigation, in this order:

| Page | Path | Contents |
|---|---|---|
| Dashboard | `/admin` | Cards: trunks (registered?), extensions online/total, active calls, calls today, missed today, voicemails waiting, disk free. Live call list (from, to, state, duration ticking, recording dot; admin buttons Hang up / Transfer / Listen). Queue tiles (waiting, longest wait, agents available). Warnings banner (restart required, SMTP not set, E911 caller ID not set, trunk down; IPQualityScore out of credits, with Dismiss, 14 §3) |
| Users & Extensions | `/admin/users` | Table: number, name, email, role, online (contacts count + state dot), DND, devices. Create/edit drawer with tabs: **General** (name, email, role, number with "next free" button), **Phone** (ring seconds, webrtc on/off, pickup group, BLF numbers multiselect, language, MOH class), **Voicemail** (enabled, PIN, email options), **Calling** (outbound class, outbound caller ID DID, recording mode), **Emergency** (E911 caller ID DID, location text), **Credentials** (SIP username/server/password reveal, regenerate, softphone QR), **Forwarding** (current DND/CFU/CFB/CFNA, editable). As built (owner follow-up to M11-T7, 2026-10-20): the Calling tab's recording mode was missing until then; it is a **Record calls** select (Never, Calls from outside, Calls to outside, All outside calls = `recordMode` never/inbound/outbound/all). Calls inside the company are never recorded, and no recording notice plays for it (only numbers set to record play one) |
| Trunks | `/admin/trunks` | List with status pill. Form: provider (voip.ms / generic). Choosing voip.ms pre-fills port, transport, codecs and shows a POP server dropdown (06 §2) plus the voip.ms-side checklist. Test button. API credentials (optional) + "Import DIDs" |
| Phone numbers (DIDs) | `/admin/numbers` | Table: number, label, trunk, destination summary ("→ IVR Main menu"), SMS on/off. Form: number, label, trunk, **DestinationPicker**, caller-name prefix, record inbound, SMS enabled + users allowed |
| Outbound rules | `/admin/outbound` | Sortable list (drag to reorder). Form: name, patterns (rows of match/strip/prepend with a pattern help popover), required class, trunk order (multi-select with order), caller ID override. **Test box**: pick an extension + type a number → shows the matching route, final dialed number, trunk, caller ID, or the reason it's denied |
| Ring groups | `/admin/ring-groups` | Form: number, name, strategy, ring seconds, members (ordered picker), music instead of ring, caller-name prefix, no-answer DestinationPicker |
| (Dashboard, Home) | | As built (M8-T2): a "Parked calls" list (slot, caller, parked by, waiting time) on the Dashboard and on Home; Home's has **Pick up 701**, which calls the slot like Call back (softphone, or the desk phone rings first) |
| Queues | `/admin/queues` | Form: every column from 02. Detail page shows live waiting callers + agent list with pause/unpause buttons + today's stats. As built (M8-T1): detail at `/admin/queues/:id`; music on hold is a select of `default` and the classes from Sounds & music (M8-T5) |
| IVRs (Digital receptionist) | `/admin/ivrs` | Form: number, name, greeting (SoundPicker), keypad grid 0–9 * # where each key gets a DestinationPicker or "unused", timeout, retries, invalid sound, direct dial toggle, timeout and invalid destinations |
| Office hours | `/admin/hours` | Time conditions: weekly grid editor (click-drag hours per day) that saves to `open_ranges`; timezone; holidays toggle; open/closed/holiday destinations; override digit; big status chip "Open now / Closed now" with Force open / Force closed / Automatic buttons. Holidays sub-tab: list + "Add US federal holidays for {year}" |
| Conferences | `/admin/conferences` | number, name, PIN, admin PIN, max members, record. As built (M8-T3): admins see the PINs in the list (they hand them out); an admin PIN needs a different room PIN |
| Paging | `/admin/paging` | number, name, members, duplex. As built (M8-T4): members are checkboxes (no order); the empty state explains `*80<ext>` |
| Sounds & music | `/admin/sounds` | Prompts list with play buttons, upload (drag-drop), TTS (M12). MOH classes with their files (M8). As built (M8-T5): a **Music on hold** section: make a set (slug name), upload, play and remove its files, delete it. The user drawer's Phone tab and the queue form pick a set from a select. An **Announcements** section (play a sound, then a destination) lives here too: no page of its own (M6-T5) |
| Phones (devices) | `/admin/devices` | Table: MAC, vendor, model, user, last provisioned. Form: MAC (any format → normalized), vendor, model, extension. Shows the provisioning URL to type into the phone, and "Preview config". As built (M10-T1): the drawer shows URL, user name (MAC) and password; a generic phone shows the manual settings instead (07 §4); Grandstream gets a note that line keys aren't set |
| Contacts | `/admin/contacts` | Company phonebook, CSV import |
| Call history | `/admin/calls` | Filters + table + CSV export; a row expands to show the CDR legs and plays the recording |
| Recordings | `/admin/recordings` | Searchable list, play, download, delete |
| Reports | `/admin/reports` | Summary charts (calls per day stacked by direction, missed per day, busiest hours heatmap), queue report table. As built (M11-T6): From/To dates (the last 30 days by default, a year at most); totals (calls, missed, average talk time); the charts are plain bars, no chart library, each bar labeled for screen readers; the heatmap is a weekday × hour table in the company time zone; the queue table has the same numbers as the queue page. Owner follow-up (2026-10-21, "total minutes, calltime, missed calls"): totals also have answered, talk time and outside minutes (in and out: inbound from arrival, since a receptionist or voicemail answers too; outbound from the answer; roughly what the provider bills), an outside-minutes-per-day chart, and one tile per voip.ms trunk with its account balance (`GET /api/reports/balance`, `getBalance`; a trunk without the API login says what to add) |
| SMS | `/admin/sms` | Same UI as the user one, with all DIDs |
| Blocked numbers | `/admin/blocked` | Users' Report spam on top (number, reason, who, when; Block or Dismiss); their count is a Dashboard tile |
| Settings | `/admin/settings` | Tabs: General, Network (public IP detect, LAN IP, local nets, STUN/TURN), SIP (ports, TCP/TLS), Numbering ranges, Email (SMTP + test), Voicemail, Recording (retention, announcement sound + **legal notice text, 08 §5**), Emergency (default E911 caller ID, notify emails/extensions + a **test notification** button that does NOT dial 911), Backups (schedule, keep, include recordings, list + download + "Back up now"), Webhooks, API tokens. Security: desk phone networks, **outside calls at once** (per extension, whole system; 0 = no limit), phone setup files, SIP TLS. Spam check (14 §7.1) |
| System | `/admin/system` | Status JSON pretty-printed, Asterisk version, generator runs list, "Apply config now", "Rollback", "Restart telephony", generated-files viewer (read-only, masked), allowlisted CLI dropdown (04 §7.3) with output panel, audit log. As built (owner follow-ups to M11-T7, 2026-10-20), laid out after 3CX's admin dashboard (not copied): a **System information** panel (version, host name, company, public IP static/dynamic, LAN IPs, ports SIP/SIPS/media/HTTPS, telephony running, restart needed; copy buttons) with how to restart (`docker compose restart asterisk` on the server; no restart button),, a **Diagnostics** panel (08 §2.6: the server's own checks, then a Quick or Complete network test through the probe, each line with how to fix it), and an **Event log** panel (severity, event code, time, source, details; Load more; Download = `/api/system/events.csv`). Events (`system_events`, kept 90 days): `trunk.down`/`trunk.up` (registration changes), `telephony.down`/`telephony.up` (AMI), `telephony.restartNeeded`, `config.failed`, `emergency.call`/`emergency.test`, `network.publicIpChanged`, `backup.done`/`backup.failed`, `disk.low`, `spam.quotaExhausted`/`spam.quotaRestored` (14 §3). Admin edits stay in the audit log (not shown yet). The dashboard's `restart_required` warning links here. Generator runs, generated files and CLI views aren't built; the admin guide's troubleshooting page covers them from the shell |

### 2.1 First-run setup wizard (`/setup`)

Shown to admins while `setup.completed` is false. Each step saves when you go
to the next one. Steps can be skipped where noted.

1. Change the initial admin password.
2. Company name, timezone (default from the browser), language.
3. Network: "Detect public IP", LAN IP (prefilled from `/api/system/status` if detectable), local nets.
   A big note about SIP ALG and port forwarding (01 §4.2) with a checkbox "I've done this".
4. Email (SMTP), skippable. Test button.
5. Trunk: voip.ms form (06 §2), with the voip.ms portal checklist next to it. "Test" must show Registered before Next is enabled. Skippable for now ("I'll add it later").
6. Phone numbers: Import from voip.ms (if API creds were given) or add manually.
7. Users: quick table to add up to 10 users (name, email, extension auto-numbered, temporary password generated and shown once).
8. Main number routing: "When someone calls {DID}, ring:" DestinationPicker (common choices first: a user, everyone (creates a ring group of all users), an IVR (creates a simple one)).
9. Emergency: default E911 caller ID DID (required if a trunk exists), notification emails. Shows the 06 §6 text about registering the address at voip.ms.
10. Done: shows "Dial *43 from any phone for an echo test" and links to the softphone.

Implementation notes (M3):
- Admins are sent to `/setup` until `setup.completed` is true; "Skip setup" completes it.
- Step 1 is already done by the forced password change at first sign-in, so it only confirms.
- Step 3 changes the SIP transports; on a fresh install the wizard restarts telephony right away
  (`POST /api/system/asterisk/restart?now=true`). `restartRequired` clears on the next AMI
  connect once Asterisk's uptime shows it started after the change.
- M3 also ships steps 7 and 8 because "calls work using only the wizard" needs a user and a
  routed number. Step 8 has the full DestinationPicker plus a **Ring everyone** button (M6-T6), which
  creates or refreshes a ring group "Everyone" with every extension (unanswered → the
  lowest-numbered user's voicemail). It does not create an IVR: that needs a recorded greeting,
  so the step points to Digital receptionist instead.
  Step 10 does not mention *43 or the softphone until M6/M5 build them.
- The first phone number added becomes `routing.defaultCallerIdDidId` when none is set.

## 3. Shared components (`src/components/`)

- **DestinationPicker**: a type select (User, Voicemail of user, Ring group, Queue,
  IVR, Office hours, Conference, Announcement, External number, Hang up), then a
  searchable target select or a number input. The value is a `Destination` object (02 §1).
  As built (M6-T6): every type that exists so far (queues joined in M8-T1, conferences in M8-T3); the target
  is a native select, which is searchable by typing. API summaries include the number where there
  is one: "Ring group Sales (500)".
  The read-only display renders "→ Ring group Sales (500)".
- **SoundPicker**: select + play button + "upload new" shortcut.
- **ExtensionPicker** (single/multi, orderable via drag handle).
- **PhoneNumberInput** (normalizes, shows formatted).
- **StatusDot**: idle green, ringing amber pulsing, in use red, on hold blue, unavailable gray, DND purple.
- **AudioPlayer**: `<audio controls preload="none">` with a download link.
- **ConfirmDialog**, **Drawer**, **DataTable** (sorting, client-side filtering for <1000 rows, server pagination otherwise).

## 4. My Phone area (`/me`)

| Page | Path | Contents |
|---|---|---|
| Home | `/me` | Status card (DND toggle, forwarding summary, queue login toggles), missed calls, new voicemails, colleagues presence list. M4 ships only new voicemails; the rest arrives with DND/forwarding (M6), call history (M7) and presence (M5-T3) |
| Calls | `/me/calls` | Own call history, click a number to call back, add to contacts, Report spam on an outside call that rang me (the spam check's line when it said medium or high, else a reason I type) |
| Voicemail | `/me/voicemail` | List (new bold), play (marks read), download, delete, search (transcript, caller). Greetings section: record in the browser (MediaRecorder → upload), upload, or delete for unavail/busy/name |
| Contacts | `/me/contacts` | Personal + company (read-only) with search, click to call |
| Reports | `/me/reports` | The admin Reports' summary of the calls made to me (rang or answered me, not the ones I made): calls, answered by me, missed, talk time, calls and missed per day, busiest hours. No outside minutes, balance or queues. Shown only with an extension |
| Messages | `/me/sms` | Threads per DID + remote number, chat bubbles, composer with 160-char segment counter, unread badges (06 §5) |
| Settings | `/me/settings` | Forwarding rules (always/busy/no answer with number fields), voicemail PIN, email options, call report email (off / hourly / daily at a time / weekly on a day at a time, company time zone; optional summaries of recorded calls, 10 §3; nothing sent for a period without calls), softphone audio devices, notification permission, change password, "Set up a phone app" (QR, 07 §5), "Mobile app" (pair a phone, list and remove paired phones, 13 §2) |

### 4.1 Presence panel
Right column on wide screens, a tab on mobile. Lists every extension with its
StatusDot, name and number, plus a search box. Click to call, or to transfer when
in a call (drop the active call onto a person = blind transfer; a menu offers attended).

As built (M5-T3): the tab is `/me/people`, shown only below the `lg` breakpoint. **Call** uses the
browser softphone when it's registered, and otherwise click-to-call: the desk phone rings first,
or a 409 comes back if no desk phone is registered. During a call each person shows **Transfer**
(blind) and **Talk first** (a consult call; the first call is held). A held call card offers
**Complete transfer** whenever another call is active, which also covers call waiting.

## 5. Browser softphone (`src/softphone/`)

### 5.1 Structure
- `SoftphoneEngine.ts`: a class with no React in it, wrapping SIP.js. Exposes an event emitter + state.
- `useSoftphone.ts`: a React hook that subscribes to the engine.
- `SoftphoneDock.tsx`: collapsed bar at the bottom of `/me` pages (status + dial button). Expands to a panel with dialpad, active calls and controls.
- `IncomingCallDialog.tsx`.

### 5.2 Engine (SIP.js 0.21)

```ts
import { UserAgent, Registerer, Inviter, Invitation, Session, SessionState, RegistererState } from 'sip.js';

class SoftphoneEngine {
  async start(creds: WebRtcCreds): Promise<void>;   // creds from GET /api/me/webrtc
  stop(): Promise<void>;
  call(number: string): Promise<CallHandle>;         // target: sip:<normalized>@<host>
  answer(id: string): Promise<void>;
  decline(id: string): Promise<void>;                // invitation.reject({ statusCode: 486 })
  hangup(id: string): Promise<void>;                 // bye() if established, cancel() if early
  hold(id: string, on: boolean): Promise<void>;      // re-INVITE with sessionDescriptionHandlerOptions { hold: on }
  mute(id: string, on: boolean): void;               // sender.track.enabled = !on
  dtmf(id: string, digit: string): void;             // RTCDTMFSender via sessionDescriptionHandler.sendDtmf
  blindTransfer(id: string, target: string): Promise<void>;          // session.refer(UserAgent.makeURI(...))
  attendedTransfer(id: string, consultId: string): Promise<void>;    // session.refer(consultSession)
  setOutputDevice(deviceId: string): Promise<void>;                  // audioEl.setSinkId
  setInputDevice(deviceId: string): Promise<void>;                   // getUserMedia constraints for next calls
}
```
- UserAgent options: `uri` = `creds.sipUri`, `transportOptions.server` = `creds.wsUrl`,
  `authorizationUsername` = `creds.authUser`, `authorizationPassword` = `creds.password`,
  `displayName`, `sessionDescriptionHandlerFactoryOptions.peerConnectionConfiguration.iceServers` = `creds.iceServers`,
  `contactParams: { transport: 'wss' }`, `logLevel: 'warn'`.
- Register with `Registerer` (expires 300). On transport disconnect, reconnect with backoff 2→30 s and re-register.
- Remote audio: one hidden `<audio autoplay>` element per call. Attach `MediaStream` from the receivers' tracks.
- Max 2 calls at once (call waiting). A second incoming call while busy shows a smaller banner. Answering it puts the first on hold.
- **One tab only:** use `BroadcastChannel('selfphoneng-softphone')` to elect a leader tab. Only the
  leader registers. Other tabs show "Softphone is active in another tab" with a "Use here" button
  that asks the leader to stop.
- Ask for microphone permission only when the user first clicks "Enable softphone". Remember the choice in
  localStorage (`softphone.enabled`, try/catch).
- Incoming call: play `/sounds/ringtone.mp3` (a CC0 file we commit to `apps/web/public/sounds/`, with its license in `SOUNDS-LICENSE.md`) in a loop,
  show a notification if permitted and the tab is not focused (`document.hasFocus()`), kept up while it rings (`requireInteraction`) and closed once it stops. It comes from a service worker (`apps/web/public/sw.js`) so it can carry **Answer** and **Decline** buttons (Chromium browsers; Firefox and Safari show no buttons); Answer and a plain click focus the softphone tab, Decline doesn't. If notifications are blocked, the softphone panel says how to allow them in the browser's site settings.
  Look up the caller name: contacts → extensions → raw number.
- Auto-answer header (paging): if the INVITE has `Call-Info: ...;answer-after=0`, answer after a short beep. (Paging only targets desk phones today. Implement the check anyway; it's 5 lines.)
- Show call quality warnings if `RTCPeerConnection.getStats()` shows packet loss > 5% or jitter > 50 ms over 5 s.

**As built (M5-T1/T2), differences from the above:**
- One tab: the leader holds a **Web Lock** (`navigator.locks`, name `selfphoneng-softphone`), which
  the browser frees if the tab dies; the BroadcastChannel only carries "Use here" (`leader.ts`).
- Ringtone and auto-answer beep are **synthesized with WebAudio** (US ring 440+480 Hz, 2 s on /
  4 s off) instead of a committed mp3, so there's no file or license to carry (`sounds.ts`).
- DTMF falls back to **SIP INFO** (`application/dtmf-relay`) when Chrome's RTCDTMFSender reports
  `canInsertDTMF = false`.
- Transfers: after the REFER's NOTIFY reports 2xx, the browser sends BYE itself (RFC 5589); SIP.js
  leaves the session up otherwise.
- Name lookup is extensions (live presence) → the caller's display name → number; contacts join in
  when they exist.
- Not yet in the panel: DND toggle (M6), Record via `*1` and recent calls (M7).
- `scripts/e2e/m5-t1.mjs` and `m5-t2.mjs` automate registration, audio, the incoming dialog, call
  waiting, hold, DTMF, both transfers and "Use here" in headless Edge; `apps/web/TESTING.md` is the
  manual run for Chrome and Firefox.

### 5.3 Softphone panel UI
- Top: registration status (Registered / Connecting / Error with a reason) + DND toggle.
- Number input with paste normalization + 12-key dialpad (also typing on the keyboard; Enter calls).
- Active call cards: name/number, timer, state; buttons Mute, Hold, Keypad, Transfer, Record (sends DTMF `*1`, which toggles automixmon on the server), Hang up.
- Transfer flow: search box (contacts + extensions) → "Transfer now" (blind) or "Talk first" (attended: places a consult call; then "Complete transfer" / "Cancel").
- Recent calls (last 10, from `/api/me/calls`).

## 6. Pages to leave out of v1
Wallboard (big-screen queue display), CRM pop-ups, chat. Don't build them.
