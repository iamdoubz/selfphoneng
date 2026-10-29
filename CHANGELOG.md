# Changelog

Versions follow [semver](https://semver.org). Each release's container images are built from its
tag (08 §3.1): `selfphoneng-api`, `selfphoneng-asterisk` and `selfphoneng-probe`, on ghcr.io and on
the Gitea registry. From v0.0.3 the release also has the probe as downloads for machines without
Docker.

## v0.0.13 — 2026-10-29

**Updating:** no database changes. Portainer: change both tags to `0.0.13` and redeploy. Compose:
`sudo scripts/update.sh v0.0.13`.

Hardening after the attacks on FreePBX servers (spec 08 §8), where stolen trunk passwords were used
for toll fraud:

- **Fraud alerts:** every admin gets an email, and the System page a warning, when the phone system
  calls an international or premium number (including Caribbean area codes, which are dialed like
  a US call but cost like abroad), when voip.ms bills calls on the trunk that this phone system
  didn't make, or when the voip.ms balance drops more than 10 in an hour. The last two need the
  voip.ms API login on the trunk. All three can be changed on Settings → Security → **Fraud
  alerts**.
- **voip.ms IP restriction** (strongly recommended): the setup checklist on Trunks now says to
  turn it on for the sub-account, with only this server's public IP. A stolen trunk password is
  then useless anywhere else ([voip.ms](docs/admin-guide/voipms.md#1-in-the-voipms-portal)).
- **Asterisk:** the api's manager login (AMI) can only do what SelfPhoneNG uses, and the image no
  longer has the modules that run commands on the server.

## v0.0.12 — 2026-10-28

**Before you update:** this version changes the database (spam reports); the api backs up first,
by itself. Portainer: change both tags to `0.0.12` and redeploy. Compose:
`sudo scripts/update.sh v0.0.12`. If you run the network test probe, update it too (see
**Probe key** below).

- **My reports:** everyone with an extension gets a Reports tab: the calls that rang them, how
  many they answered and missed, talk time, calls and missed calls per day, and their busiest
  hours.
- **Report spam:** on the Calls page, an incoming outside call has a **Report spam** button. When
  the spam check flagged the call, its finding is the reason; otherwise the person types one.
  Reports wait at the top of **Blocked numbers** for an admin to Block or Dismiss, and the
  Dashboard counts them.
- **Second security review** (spec 08 §7), eight findings fixed, none critical:
  - Signing in by email (OpenID or directory) no longer matches admins or anyone who already has
    a connected sign-in, and connecting an OpenID account only finishes in the browser that
    started it.
  - **Recordings, transcripts and AI summaries** only go to whoever made or answered the call.
    Ring group and queue members whose phone only rang no longer get a coworker's recording, nor
    its summary in their call report email or on their Contrack timeline.
  - The `voicemail.new` webhook no longer carries the voicemail's transcript.
  - Changing the Contrack address asks for the company token again, and everyone reconnects
    their own Contrack token.
  - A directory account can only be swapped for another by an admin.
- **Probe key** (strongly recommended): Settings → Network → **Generate key**, then set it as
  `PROBE_KEY` on the probe and restart it. The probe then only answers your server. Without a key
  it still works, and Diagnostics warns. Behind your own reverse proxy (`TRUST_PROXY=true`), the
  proxy must run on the probe's machine.
- **Asterisk 24.0.0-rc3.** TLS trunks get a health check again, and Test checks them too (rc2
  couldn't check them over TLS). `pnpm test:asterisk-upgrade` now checks what SelfPhoneNG relies
  on Asterisk doing before any version change.
- **Docs:** a CrowdSec rule for slow SIP scanners, and how to check that CrowdSec bans
  ([network](docs/admin-guide/network.md#crowdsec)).

## v0.0.11 — 2026-10-28

**Updating:** no database changes. Portainer: change both tags to `0.0.11` and redeploy. Compose:
`sudo scripts/update.sh v0.0.11`.

- **Phones:** on an iPhone a ringing call dimmed the screen but showed no Answer button (iOS
  zoomed into the small sign-in fields and stayed zoomed, so the call dialog was off screen).
  Fields are now 16px on touch screens and buttons at least 44px. A ringing call gets its own
  screen: full screen on a phone, with big round Decline and Answer buttons. My Phone's tabs fold
  into a menu button on narrow screens.
- **New look:** colors from the logo (blue, and its navy for dark mode), cards on an off-white
  page, and text that is easy to read in both themes (all text at least WCAG AA). Icons
  throughout.
- **Admin sidebar** grouped into Call routing, People, Features, History and System.
- **My Phone Home** is a set of cards: My status, Missed calls (with call back) and New
  voicemails.
- **Browser phone:** a status pill (Ready, Connecting…), phone-style call buttons with icons
  (Mute, Hold, Keypad, Transfer, Hang up) and a round keypad with the letters under the digits.

## v0.0.10 — 2026-10-27

**Before you update:** this version changes the database (spam check); the api backs up first,
by itself. Portainer: change both tags to `0.0.10` and redeploy. Compose:
`sudo scripts/update.sh v0.0.10`.

- **Spam check** (spec 14, off until you turn it on in Settings → Spam check): when an outside
  US caller isn't in the company's or your contacts, the number is looked up and what's known
  shows while it rings. The browser phone shows a **Likely spam** or **Possible spam** badge with
  a line such as "Fraud score 92 · spammer · VOIP"; desk phones show the caller's name as
  **SPAM LIKELY** or **Spam risk** (you can change these) when the answer is quick; call
  history keeps the badge. It's information only: calls are never blocked or delayed, and a
  failed lookup just shows nothing. Two sources, either or both:
  - **IPQualityScore** (1,000 lookups a month free): sends callers' numbers to IPQualityScore,
    so turning it on asks you to confirm. Answers are kept 14 days for flagged numbers and 3 for
    the rest. When the lookups run out the dashboard says so, checks fall back to the FTC list,
    and it carries on by itself when lookups are back.
  - **FTC complaint list** (free api.data.gov key): downloaded to the server, so nothing leaves
    it. The first download takes about 7 hours; then it fetches what's new every 24 hours.
  - See the [admin guide](docs/admin-guide/spam-check.md), including privacy and GDPR.
- Database changes: `spam_lookups`, `ftc_complaints` (the api backs up first).

## v0.0.9 — 2026-10-27

**Before you update:** this version changes the database (paired phones); the api backs up first,
by itself. Portainer: change both tags to `0.0.9` and redeploy. Compose:
`sudo scripts/update.sh v0.0.9`.

- **Answer from the notification**: the softphone's incoming call notification has **Answer** and
  **Decline** buttons (Chrome and Edge; Firefox and Safari show it without buttons). It now shows
  whenever the softphone tab isn't in front, not only when it's hidden, stays up while the call
  rings and goes away once it stops. If notifications are blocked, the softphone panel says how
  to allow them.
- **Pair the mobile app** (spec 13): My settings → Mobile app shows a one-time code (QR, or
  server + code, good for 10 minutes) that our own Android/iPhone app trades for a device token.
  A paired phone acts as its user, never as an admin, and is listed there to remove. Changing or
  resetting a password, or disabling a user, removes their paired phones. The app itself is
  still in testing and not in the app stores.
- Database changes: `mobile_devices` (the api backs up first).

## v0.0.8 — 2026-10-26

**Before you update:** this version changes the database (sign-in); the api backs up first, by
itself. Portainer: change both tags to `0.0.8` and redeploy. Compose:
`sudo scripts/update.sh v0.0.8`. Sign-in works as before until you set up single sign-on in
Settings → Sign-in (admin guide: [Sign-in](docs/admin-guide/sign-in.md)). Every route is now rate
limited, 600 requests a minute per client IP by default (`RATE_LIMIT_PER_MINUTE`, 0 turns it off).

- **Sign in with OpenID Connect** (spec 12, admin guide: [Sign-in](docs/admin-guide/sign-in.md)):
  Keycloak (tested), and any provider that follows the standard: Authentik, Authelia, Zitadel,
  Entra ID and others are expected to work. People connect their
  account on My settings → Sign-in and then sign in with either it or their password. The admin
  picks passwords only, OpenID only, or both. Provider groups can decide who may sign in and who
  is an admin. Signing out also signs out at the provider, and someone disabled there loses their
  session here within 20 minutes. No accounts are made automatically: an admin still creates each
  user. Admins keep their password, so the phone system stays reachable if the provider is down.
- **Sign in with the company directory** (LDAP / LDAPS): presets for Active Directory and Samba
  AD, OpenLDAP, FreeIPA and lldap (AD and lldap tested), and a Test button. People use their directory username or email
  and password. New users are matched by email; anyone who chose their own password, and every
  admin, connects once on My settings → Sign-in. An admin filter can make people admins (nested AD
  groups count).
- **Leavers**: every hour, someone removed from the directory (or disabled there) is disabled
  here, password included. A dashboard warning shows when the directory can't be reached, or when
  a check would disable most people (it then disables nobody).
- **Security** (a two-reviewer audit of the new sign-in and all 207 API routes): rate limits on
  every route, stricter on Test buttons; a password asked again (change password, two-step on and
  off) counts like a sign-in; a saved directory or provider password is never sent to a new
  address; and a role set by the provider is read-only on Users.
- Database changes: `user_identities`; `sessions` records how each session was made; a user may
  have no password (the api backs up first).

## v0.0.7 — 2026-10-23

**Before you update:** this version changes the database (call reports, contacts); the api backs
up first, by itself. Portainer: change both tags to `0.0.7` and redeploy. Compose:
`sudo scripts/update.sh v0.0.7`. Contacts start in Simple mode with empty address books;
Contrack is optional and off until you set it up (admin guide: [Contacts](docs/admin-guide/contacts.md)).
Desk phones pick up their new directory at their next daily check (or reboot them).

- **Contacts** (spec 11, admin guide: [Contacts](docs/admin-guide/contacts.md)): each person's own
  contacts and the company's, in My Phone → Contacts and Admin → Contacts. Import `.vcf` files
  (iPhone, Android, Google, Outlook, Apple) or CSV, with a preview; duplicates are skipped. Share
  contacts with colleagues or everyone: they Accept or Deny each one, and nothing lands in their
  contacts without it. Contact names show in call history, voicemail, Home, the browser phone,
  and the call report email, with **Add to contacts** on calls and voicemails from numbers that
  aren't contacts yet.
- **Caller names on desk phones while they ring**: the caller's name from the ringing person's
  own contacts (or the company's), per phone, so nobody sees a colleague's private contact names;
  ring group and queue prefixes ("Sales:") stay in front.
- **Desk phone directories** now have the phone owner's own contacts, after the extensions and
  before the company's.
- **Contrack** (optional): the setup wizard (new step 8, Contacts) and Settings → Contacts offer
  [Contrack](https://github.com/arvarik/contrack), a self-hosted contact and relationship manager,
  as a second container (`deploy/contrack/compose.yml`, pinned to 2.0.2). Each person connects
  their own Contrack account in My settings → Contacts, and the company has one everyone sees.
  Calls go on the contact's Contrack timeline, optionally with the call summary and its action
  items (the first becomes a follow-up); contacts from before Contrack can be copied over.
- **Call report email** (My settings → Call report): your calls every hour, day or week, at the
  time you pick (company time zone), with whether each was recorded and, optionally, each
  recorded call's summary. No calls, no email.
- **Voicemail search**: search your messages by what was said (the transcript) or by the caller.
- Database changes: call report columns on `extensions`; `contact_shares`, `contrack_call_log`,
  and Contrack columns on `users` (the api backs up first).

## v0.0.6 — 2026-10-21

**Before you update:** this version changes the database (call transcripts); the api backs up
first, by itself. Portainer: change both tags to `0.0.6` and redeploy. Compose:
`sudo scripts/update.sh v0.0.6`. Call transcripts are off until you turn them on in Settings → AI;
calls recorded before that get no transcript.

- **Call transcripts and summaries** (Settings → AI, admin guide: [Local AI](docs/admin-guide/ai.md)):
  recorded calls are written out a minute or two after they end, caller and other side apart, with
  a summary and action items from the language model. The Recordings page shows them and searches
  what was said; the people on a call can read its transcript. Database change: four columns on
  `recordings` (the api backs up first).

## v0.0.5 — 2026-10-21

**Before you update:** this version changes the database (voicemail transcripts); the api backs
up first, by itself. Portainer: change both tags to `0.0.5` and redeploy. Compose:
`sudo scripts/update.sh v0.0.5`. The AI is optional and off until you set it up: a second stack
from `deploy/ai/compose.yml`, then Settings → AI (admin guide: [Local AI](docs/admin-guide/ai.md)).
After updating, phones set up automatically pick up the dial plan at their next daily check (or
reboot them).

- Admin guide: [Analog phones (ATAs)](docs/admin-guide/ata.md), setting up a Grandstream HT802 V2
  by hand.
- **Dial plan:** a user's Credentials tab shows a dial plan for analog phone adapters, made from
  your outbound routes and internal number lengths: 911 and full outside numbers go out the moment
  they're dialed instead of after a pause. Yealink desk phones get the same as dial-now rules.
- New internal numbers can no longer start with 911 or 9911, so 911 can go out at once (numbers
  you already have keep working).
- **Local AI** (admin guide: [Local AI](docs/admin-guide/ai.md)): Settings → AI sets a language
  model, speech to text and text to speech, each with a Test, on this server or the local network
  only (anything else is refused). `deploy/ai/compose.yml` is a second stack with Speaches
  (Whisper and Kokoro) on the GPU. `AI_*` in `.env` sets them on a new install.
- **Voicemail transcripts:** with AI on, a new message's words are in the voicemail email and on the
  voicemail page. Database change: `voicemail_messages.transcript` (the api backs up first).

## v0.0.4 — 2026-10-21

**Updating:** no database changes. Portainer: change both tags to `0.0.4` and redeploy. Compose:
`sudo scripts/update.sh v0.0.4`.

- Settings → Security has the **SIP port** and **Accept SIP over TCP** (5060 and on by default,
  as before). Both were settings with no field. Another port, such as 5080, helps when a router or
  the ISP keeps UDP 5060 for itself: a Complete network test shows UDP getting through while SIP
  on UDP 5060 doesn't. Changing it needs a telephony restart, a new router forward and setting the
  phones up again; trunks keep working. A port that another part of SelfPhoneNG listens on is
  refused. The admin guide (Network) explains when to change it.

## v0.0.3 — 2026-10-21

**Before you update:** this version changes the database (music-on-hold order). The api backs up
first, by itself (see the admin guide, Updating). Compose installs from v0.0.2 get
`scripts/update.sh` with the release: `git fetch --tags && git checkout v0.0.3`, then
`sudo scripts/update.sh v0.0.3`. Portainer: change both tags to `0.0.3` and redeploy. Optional:
`RTP_PORT_START`/`RTP_PORT_END` on the api, then open that range instead of 10000–20000.

- **Any internal number:** users, ring groups, queues, digital receptionists, conference rooms and
  paging groups take any free number of 1 to 6 digits, for example **1** for the first user (the
  setup wizard asks for it too). Settings → **Numbering** sets where **Next free** looks. A
  one-digit number and a menu key of a digital receptionist that lets callers dial numbers can't
  be the same. Ring groups, queues, voicemail, pickup (`**`), queue login (`*45`), forwarding
  (`*72`) and intercom (`*80`) now work with one-digit numbers.
- **Music on hold order:** a set plays in the order shown on Sounds & music (move files up and
  down; new uploads go last), or **Shuffle** for random order. Before, the order was Asterisk's.
- **Reports:** totals now include answered calls, talk time and **outside minutes** (in and out,
  roughly what voip.ms bills), with outside minutes per day, and the **voip.ms balance** of each
  trunk that has the API login.
- **System → Diagnostics:** checks what usually keeps phones off the network (public IP, DNS,
  local networks, the phone network limit, SIP listening, free audio ports), with how to fix each.
  A **Quick** or **Complete network test** checks the ports from the internet through a network
  test probe you run outside your network; set its URL in Settings → Network. The probe comes as
  a Docker image (`selfphoneng-probe`), and, for a machine without Docker, as a single Linux
  executable (x64 and arm64) attached to each release, with a systemd unit.
- The call audio port range is configurable: `RTP_PORT_START` and `RTP_PORT_END` (default
  10000–20000).
- Updating (Docker only): a new version backs up before it changes the database, and stops
  instead if the backup fails. `scripts/update.sh` updates a compose install to a release, checks
  the result and goes back by itself if the check fails. The admin guide's "Updating" section
  covers compose and Portainer.
- Container logs are capped (3 × 10 MB) in `docker-compose.yml`.
- Security leftovers from the review (08 §6), all fixed:
  - Asterisk no longer loads the modules that can run host commands (`app_system`, `func_shell`,
    `app_disa`, `res_agi`, `app_externalivr`).
  - Turning two-step sign-in on asks for your password again.
  - `*97`/`*98` voicemail logins: one at a time per phone, 10 an hour.
  - Phone setup files: an unknown MAC gets the same answer as a known one.
  - The login limiter no longer keeps every email ever tried until a restart.

## v0.0.2 — 2026-10-21

- Fix: calls to a user with Linphone on an iPhone registered dropped at once, for every device of
  that user. Its push parameters hold `&`, which split the dial string.

## v0.0.1 — 2026-10-20

The first tagged build, for testing. Not for production yet: the v1.0 definition of done
(docs/spec/09-roadmap.md) still needs a week on a real server with real calls, and the open
real-account checks.

- Phones, users and extensions; calls between desk phones, softphones and the browser phone.
- voip.ms trunks (registration or IP auth, UDP/TCP/TLS + SRTP), phone numbers, outbound rules
  with calling permissions, 911 with E911 caller ID and alerts.
- Voicemail with email, digital receptionists, office hours, ring groups, queues, parking,
  pickup, conference rooms, paging and intercom, music on hold.
- Call history, recordings, the live dashboard (listen, whisper, barge), reports.
- Desk phone provisioning (Yealink, Grandstream), company phonebook, Linphone setup QR.
- Security: two-step sign-in for admins, phone network limit, limits on outside calls at once,
  the M11-T8 security review (08 §6); backups and restore; background watches; webhooks and API
  tokens; the admin guide.
- Not in this release: SMS (parked until wanted), `scripts/update.sh` (before v1.0).
