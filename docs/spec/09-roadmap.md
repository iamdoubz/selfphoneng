# 09 — Roadmap: milestones and tasks

Work strictly in order. Each task lists what to **read**, what to **build**, and
when it's **done**. A milestone is done only when every task in it is done
and the milestone check passes.

Legend: 📖 read · 🔨 build · ✅ done when

---

## Backlog (owner's order, 2026-10-21)
0. **Contacts** (owner, 2026-10-23: needed next), tasks C1–C6 in [11 §6](11-contacts.md#6-order-of-work):
   Simple (builtin phonebook) or Robust (Contrack), picked in the setup wizard. The owner uses
   Contrack.
1. **Grandstream HT802 V2 set up automatically** (step 3 of
   [Analog phone adapters](#analog-phone-adapters-owner-2026-10-21-wanted-the-owner-is-buying-an-ht802-v2)):
   several lines on one device and the `grandstream-ata.ts` template with the dial plan. Starts
   when the owner's HT802 V2 arrives: its config export gives port 2's P-values.
2. Cisco ATA 191/192 and SPA112/122 (step 4 there).
3. [More SIP providers](#more-sip-providers-owner-2026-10-21-wanted-next-after-002): Telnyx,
   Flowroute, Twilio.

---

## M0 — Skeleton that boots

**M0-T1 Workspace**
📖 00 §4, §5
🔨 pnpm workspace with `apps/api`, `apps/web`, `packages/shared`. TypeScript strict in all three, ESLint + Prettier, vitest. Root scripts `dev`, `build`, `test`, `lint`, `typecheck`. `LICENSE` (AGPL-3.0-or-later), `.gitignore` (includes `data/`, `.env`), `README.md` (one paragraph + link to spec).
✅ `pnpm install && pnpm lint && pnpm typecheck && pnpm test` passes on a clean clone.

**M0-T2 Shared phone utils**
📖 00 §8
🔨 `packages/shared/src/phone.ts`: `normalizeNumber`, `formatNumber`, `isReservedNumber`. Exhaustive tests (at least 25 cases, including `+1 (312) 555-1234`, `3125551234`, `13125551234`, `+44 20 7946 0958`, `*97`, `911`, garbage).
✅ Tests pass.

**M0-T3 api hello**
📖 01 §1.2, 04 §1 (steps 1, 2, 5, 6 only)
🔨 `config.ts` with zod env parsing, pino logger with redaction, Fastify with `GET /healthz` → `{ok:true}`, static serving of `./public` with SPA fallback.
✅ `pnpm --filter @selfphoneng/api dev` serves `/healthz`. A missing `APP_SECRET` exits 1 with a clear message.

**M0-T4 web hello**
🔨 Vite + React + Tailwind + react-router. One page "SelfPhoneNG" with a dark-mode toggle. In dev, Vite proxies `/api` to the api and `/ws` to Asterisk (127.0.0.1:8088), the same split as the reverse proxy.
✅ `pnpm --filter @selfphoneng/web build` outputs `dist/`. The page renders at 360 px and desktop widths.

**M0-T5 Asterisk image**
📖 01 §2, §3
🔨 `asterisk/Dockerfile`, `entrypoint.sh`, and every static conf file from 01 §3. Pin `ASTERISK_VERSION` to the newest 24.x and write it into 01 §2.
✅ `docker compose up -d asterisk` stays up. `docker compose exec asterisk asterisk -rx "core show version"` prints 24.x. `module show like pjsip` lists res_pjsip. The log has no `ERROR` lines.

**M0-T6 Full compose**
📖 01 §1
🔨 `docker-compose.yml`, `.env.example`, api Dockerfile, `scripts/install.sh`.
✅ On a fresh Ubuntu/Debian VM: `./scripts/install.sh` → `curl http://127.0.0.1:8080/healthz` returns ok, and the web page loads through the api.

**M0-T7 CI**
🔨 CI workflow (`.github/workflows/ci.yml`; it's also Gitea Actions-compatible) running lint, typecheck, test, and building both Docker images.
✅ Green on push.

---

## M1 — Database, auth, admin shell

**M1-T1 Schema + migrations**
📖 02 (all)
🔨 `db/schema.ts` matching the DDL exactly, plus the first migration. `services/settings.ts` with a zod schema and default per key (02 §3).
✅ Migration applies to an empty DB. A test compares `information_schema.columns` for 5 key tables against the spec.

**M1-T2 Secrets**
📖 04 §3
🔨 `crypto/secrets.ts` + tests.
✅ Round-trip, tamper and wrong-key tests pass.

**M1-T3 Auth**
📖 04 §2
🔨 Login/logout/me/change-password, sessions, CSRF header check, rate limits, guards, initial admin bootstrap, `must_change_password` enforcement, audit log writes for login events.
✅ Integration tests (Fastify `inject` + a test DB): good login sets the cookie; bad password → 401 and is audited; 6th failure → 429; POST without `X-Requested-With` → 403; non-admin hitting admin route → 403.

**M1-T4 Users API + admin shell UI**
📖 04 §7.1, 05 §1, §2 (Users page, General tab only)
🔨 `/api/users` CRUD, login page, change-password page, admin layout with sidebar (pages not built yet show "Coming in M<n>"), Users table + drawer (General tab).
✅ An admin can log in, is forced to change the password, then creates/edits/deletes a user. Every change shows up in `audit_log`.

---

## M2 — Phones register and call each other

**M2-T1 AMI client**
📖 04 §4
🔨 `ami/client.ts` + parser tests with recorded fixtures.
✅ Against the real container: login works, `command('core show version')` returns text, killing Asterisk triggers reconnect with backoff, and pending actions reject.

**M2-T2 Generator core**
📖 03 §1, §2, §3, §11, §12.1–12.2
🔨 `loadSnapshot`, `render` (initially: header only), `apply` with mutex, debounce, atomic writes, `.prev`, reload command mapping, `generator_runs`. Sanitizers + hostile-input tests.
✅ `apply` writes files and sends only the needed reloads. Sanitizer tests pass.

**M2-T3 PJSIP for extensions**
📖 03 §5.1, §5.2, 01 §4.3
🔨 Render global/system/transports/extension endpoints; transport-hash restart detection; `rtp_selfphoneng.conf`.
✅ Golden cases `empty`, `one-user`, `webrtc-disabled`, `hostile-names` pass. Asterisk loads them without errors (`pjsip show endpoints` lists 101 and 101-web).

**M2-T4 Base dialplan**
📖 03 §6.0–6.3, §6.6 (users only), §9
🔨 `dialplan/static.ts` (all static contexts from §6.2), the globals file, `sp-local-numbers` for users with hints. Voicemail is disabled for now (ARG3 = 0) until M4.
✅ Golden tests updated. `dialplan show sp-local-numbers` shows users and hints.

**M2-T5 Extensions API + UI**
📖 02 (extensions, user_runtime_state), 04 §7.2, §7.3 (extensions), 05 §2 (Users page tabs General/Phone/Credentials)
🔨 Numbering service, extensions CRUD (generates SIP password and voicemail PIN), credentials reveal (audited), regenerate password. Every change calls `requestApply`.
✅ Creating user 101 in the UI → within 2 s `pjsip show endpoint 101` exists.

**M2-T6 Live state v1 + dashboard**
📖 04 §5.1 (extension states + contacts only), §5.2
🔨 Live store, initial load, ExtensionStatus/ContactStatus handlers, `/api/live` WS, dashboard "extensions online", StatusDots in the Users table.
✅ **Milestone check:** register two softphones (e.g. baresip/MicroSIP/Linphone) on the LAN as 101 and 102. 101 calls 102 → two-way audio for 30 s. The dashboard shows both online, and the dots go red during the call. Write `apps/api/test/sipp/register-and-call.xml` (or a baresip script) that automates register + call + BYE and run it in `pnpm test:asterisk`. **Done as `apps/api/test/asterisk/call-test.ts` (baresip in Docker, checks RTP both ways).**

---

## M3 — Real phone number in and out (voip.ms)

**M3-T1 Trunks**
📖 03 §5.3, 06 §1, §2
🔨 Trunks CRUD + form with the voip.ms preset and checklist; registration status in live state (`Registry`, `PJSIPShowRegistrationsOutbound`); `POST /api/trunks/:id/test`.
✅ With a real voip.ms sub-account, the trunk shows **Registered** in the UI.

**M3-T2 DIDs + inbound routing (to a user)**
📖 03 §6.4, §6.5, 06 §3, 02 §1
🔨 Destination zod schema + `destApp` + `findReferences`/`assertDestinationExists`; DIDs CRUD; minimal DestinationPicker (user + hangup + external); `sp-from-trunk-*`, `sp-did-exists`, `sp-inbound`.
✅ A call from a mobile phone to the DID rings 101. **Record in 06 §3 which header carried the DID.** Golden case `voipms-basic` passes.

**M3-T3 Outbound routes + caller ID**
📖 03 §6.12, 06 §4
🔨 Outbound routes CRUD with reorder + test box; class check; caller ID priority; trunk failover; channel limit; default routes created when the first trunk is created.
✅ 101 dials a mobile number → it rings, and the caller ID shown is the DID. An extension with class `local` dialing a national number hears `ss-noservice`. `011…` is denied while the route is disabled. **Record in 06 §4 whether per-call caller ID is honored.**

**M3-T4 Emergency**
📖 03 §6.14, 06 §6, 04 §5.3
🔨 Emergency contexts, `SpEmergency` handler (email, ring-out, banner, `emergency_events`), test-notification button, dashboard warnings.
✅ Unit/golden tests show 911 bypasses class/limits. The test-notification button sends the email and rings the notify extension. **Do not dial 911.**

**M3-T5 Setup wizard (steps 1–10; steps 7–8 with the M3 destination choices, see 05 §2.1)**
📖 05 §2.1
✅ A fresh install can be taken to "inbound and outbound calls work" using only the wizard.

> **⚠ M3 is NOT fully accepted yet — open real voip.ms checks.** M3 was pushed
> after passing against a simulated voip.ms (a second Asterisk on the Docker
> network). These checks need the owner's real voip.ms account and must be done
> before v1.0 (the owner enters the credentials; never dial 911):
>
> - [ ] M3-T1: the real sub-account trunk shows **Registered** in the UI.
> - [ ] M3-T2: a mobile → DID call rings a phone; record in 06 §3 which header carried the DID.
> - [ ] M3-T3: an outbound call shows the DID as caller ID on the mobile; record in 06 §4 whether per-call caller ID (Remote-Party-ID) is honored.

---

## M4 — Voicemail

**M4-T1** Voicemail config (03 §7), turn on ARG3 in `sp-sub-user`, `*97`/`*98`, MWI via `mailboxes`.
✅ An unanswered call to 101 leaves a message, the desk phone MWI light turns on, and `*97` plays it.

**M4-T2** Watcher + DB index + email (04 §5.6, §10), SMTP settings + test.
✅ The voicemail email arrives within 10 s with a playable attachment.

**M4-T3** User portal: Home + Voicemail page + greetings (05 §4), API operations with renumbering.
✅ Mark read/delete in the web UI updates the phone's MWI light within 5 s. A greeting recorded in the browser plays to callers.

---

## M5 — Browser softphone

**M5-T1** `/api/me/webrtc`, reverse-proxy `/ws` (Caddy + nginx example), engine (05 §5.2).
✅ The browser registers (`pjsip show contacts` shows 101-web), and calls between browser and desk phone have two-way audio, both on the LAN and from a phone hotspot outside the LAN.

> **⚠ Open real-network check (M5-T1).** Verified in Docker only (`scripts/e2e/m5-t1.mjs`:
> register, browser ↔ softphone both directions, two-way audio). Still to do on the owner's
> server behind the reverse proxy: a browser on the LAN and one on a phone hotspot, each with
> two-way audio to a phone.

**M5-T2** Dock UI, incoming dialog, hold/mute/DTMF, blind + attended transfer, one-tab leader election, audio device selection, notifications.
✅ A manual test script in `apps/web/TESTING.md` (12 steps) passes in Chrome and Firefox.

> **⚠ Open manual check (M5-T2).** `scripts/e2e/m5-t2.mjs` passes in headless Edge in Docker
> (incoming dialog, call waiting, hold, DTMF, blind + attended transfer, "Use here"). The owner
> still has to run `apps/web/TESTING.md` in Chrome and Firefox on the real server.

**M5-T3** Presence panel + click-to-call (`/api/me/click-to-call`).
✅ Presence dots change in < 1 s. Click-to-call rings the user's desk phone first.

---

## M6 — Call flows

**M6-T1** Sounds: upload, convert, play, delete with references (04 §6, 05 §2 Sounds).
**M6-T2** Ring groups (03 §6.7) + UI.
**M6-T3** IVR (03 §6.9) + keypad-grid UI.
**M6-T4** Time conditions + holidays + override codes (03 §6.10, §6.13) + weekly grid UI + US federal holiday generator.
**M6-T5** Announcements (03 §6.11).
**M6-T6** Full DestinationPicker (all types) used everywhere.
**M6-T7** Feature codes DND/CF/pickup/echo/say-ext (03 §6.13) + `SpToggle` handling + forward validation (04 §5.3) + `/me/settings` forwarding UI.
**M6-T8** Blocked numbers (AstDB sync, 04 §5.5).
✅ **Milestone check:** golden cases `ringgroups`, `ivr-business-hours`, `holidays` pass. Manual scenario: DID → office hours (open) → IVR "press 1 sales (ring group 500 ringall), 2 support (user 102)". Outside hours → voicemail of 101. `*311` forces open. A blocked number is rejected.

---

## M7 — History, recordings, live dashboard

**M7-T1** CDR ingestion + aggregation (04 §5.4) with recorded fixtures for 8 scenarios.
**M7-T2** Call history pages (admin + `/me/calls`) + CSV export.
**M7-T3** Recording (03 `sp-sub-record`, record modes, DID record flag, announcement) + recordings page + retention job.
**M7-T4** Full live state (calls, parking, queues placeholders) + dashboard live call list + admin hangup/transfer.
✅ Each fixture scenario produces the expected `calls` row. A recorded call is playable from history. The live list matches `core show channels` during 3 concurrent calls.

---

## M8 — Queues, park, pickup, conference, paging, MOH

**M8-T1** Queues (03 §6.8) + members + pause via `*45`/UI + queue live tiles + `GET /:id/stats`.
**M8-T2** Parking (`res_parking.conf`, `sp-parkedcalls` include) + parked calls in the live UI + BLF hints for slots.
**M8-T3** Conferences with PIN/admin PIN (03 §6.11).
**M8-T4** Paging/intercom (`sp-page-*`, `*80`) + auto-answer test on a real Yealink or Grandstream.
As built: tested with baresip phones that honor the auto-answer headers (`sip_autoanswer`). **Open:** the check on a real Yealink or Grandstream, when one is available.
**M8-T5** MOH classes (03 §8).
✅ **Milestone check:** golden `queue` case passes. Scenario: 3 callers wait in a queue with 2 agents. One agent pauses with `*45550`. The caller who waits past `max_wait_seconds` goes to the timeout destination. A parked call on 701 can be picked up from another phone. **Done as `scripts/e2e/m8-check.mjs` (queue 552, so `*45552`; callers from a DID; the agent who answers parks the call and another phone picks up 701).**

---

## M9 — SMS

**M9-T1** voip.ms API client (06 §5.1) + DID import + server list.
As built: done against a fake voip.ms API. **Open:** check the response shapes with a real account (API enabled, this server's IP allowed; no SMS needed), 06 §7.

**Parked (2026-10-19, owner):** the owner's voip.ms account has no SMS, so M9-T2 and M9-T3 wait until SMS is wanted. Pick them up from here; nothing else depends on them (the SMS admin page stays "coming later").
**M9-T2** Inbound hook (06 §5.2) with a captured real fixture.
**M9-T3** SMS UI (admin + `/me/sms`), unread badges, `did_sms_users`.
✅ Two-way SMS with a mobile phone works. Messages show in < 2 s.

---

## M10 — Provisioning and phone apps

**M10-T1** Devices CRUD + `/prov` endpoints + auth/rate-limit (07 §2).
**M10-T2** Yealink + Grandstream templates + phonebook XML + timezone table (07 §3).
**M10-T3** Linphone QR provisioning (07 §5) + "Set up a phone app" page.
**M10-T4** Spy/whisper/barge (04 §7.3).
As built: all four tasks done and tested with simulated phones (`scripts/e2e/m10-t1…t4.mjs`). **Open:** the milestone check below needs a real Yealink (and a Grandstream for its keys) and the Linphone app scanning the QR; the owner has neither yet (2026-10-19). Vendor key names stay (verify per model) until then.
✅ A factory-reset Yealink pointed at the URL registers with the right name and BLF keys. Linphone on a phone registers by scanning the QR.

---

## M11 — Hardening, ops, docs

**M11-T1** Security headers, phone ACL setting (08 §2.2), TOTP for admins, PIN rules.
**M11-T2** TLS SIP transport (cert path, compose volume, trunk TLS + SRTP option for voip.ms).
**M11-T3** Backups + restore script (04 §8.1). Test restore on a second VM.
**M11-T4** Jobs: publicIpWatch, trunkWatch, diskWatch, retention (04 §8).
**M11-T5** Webhooks + API tokens (04 §9, §2.3).
**M11-T6** Reports page (05 §2).
**M11-T7** `docs/admin-guide/`: install, voip.ms setup with screenshots, NAT/SIP ALG, firewall + fail2ban/CrowdSec, E911 duties, recording law notice, troubleshooting (08 §3.3), updating, backup/restore.
**M11-T8** Security review: run through 08 §1 line by line, and get a review from a separate agent that didn't write the code. Fix findings.
✅ An outside tester follows only the admin guide and gets inbound/outbound calls working on a fresh VM.

---

## More SIP providers (owner, 2026-10-21: wanted, next after 0.0.2)
Quick hits: **Telnyx, Flowroute, Twilio**, as presets beside voip.ms with their own setup checklist
(like 06 §1). The generic trunk misses, for these:
- Password on calls without registering: `authMode: 'ip'` sends no `outbound_auth` (Twilio's SIP
  trunks don't register).
- More than one inbound address per trunk: `identify` only matches the server host; they send from
  several addresses or ranges.
- Numbers sent as +1…: caller ID goes through `s.digits`, which drops the `+` (Twilio needs E.164).
- Flowroute's tech prefix (`12345678*`) in a route's prepend: check it fits.
Each one checked against a real account before it's called supported (06's verify rule).

## Analog phone adapters (owner, 2026-10-21: wanted; the owner is buying an HT802 V2)
1. Done: admin guide page for setting one up by hand (`docs/admin-guide/ata.md`).
2. Done: the dial plan (`provisioning/dialplan.ts`), made from the enabled outbound routes and the
   lengths internal numbers use, with 911/9911 always. Yealink gets dial-now rules for what can't
   grow into a longer number (911, 9911, full outside numbers); the Credentials tab shows the
   Grandstream form for hand-set-up ATAs. Internal numbers starting 911/9911 are now reserved.
   Grandstream desk phones keep their own plan: a restrictive one there is untested. Check on the
   HT802 that a rule that can't grow goes out at once, and the Yealink dial-now syntax on a phone.
3. Several lines on one device (`device_lines`: device, port, extension; the setup file lists every
   line of that MAC) and a `grandstream-ata.ts` template for the HT802 V2. Its port 2 P-values
   differ from the desk phones' account 2: take them from Grandstream's config template or an
   export of the real unit, not from memory. Fax: Pass-Through and PCMU only; T.38 stays out
   (00 §2).
4. Later (Cisco): `cisco-ata.ts` for ATA 191/192 (multiplatform firmware) and SPA112/122
   (end of support 2025-05-31): `<flat-profile>` XML, `_1_`/`_2_` per line, served at
   `/prov/<mac>.xml`. No DHCP login, so the Phones page shows the `Profile_Rule` to paste
   (`[--uid <mac> --pwd <password>] https://<host>/prov/$MA.xml`). Needs a real unit.

---

## M12 — Nice to have (after v1.0)
- Piper TTS for prompts (04 §6).
- Record prompts by phone.
- Wallboard page for queues.
- Push gateway for mobile apps.
- Polycom provisioning (07 §3.3).
- Multi-tenant (big redesign; needs a decision record).

---

## Definition of done for v1.0
Tracked box by box in [`docs/v1-checklist.md`](../v1-checklist.md).
All of M0–M11 done (including the open real voip.ms checks under M3), plus: 7 days running on the owner's server handling real calls with
no crash/restart of the api or Asterisk, and nightly backups restoring cleanly. Also updating (08 §3.1, Docker only): the api's
backup before migrating, `scripts/update.sh` for compose installs, and the admin guide's "Updating" section, tested by
updating a real running install (compose with the bundled Caddy, and the owner's Portainer stack) with calls and backups.
