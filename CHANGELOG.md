# Changelog

Versions follow [semver](https://semver.org). Each release's container images are built from its
tag (08 §3.1): `selfphoneng-api`, `selfphoneng-asterisk` and `selfphoneng-probe`, on ghcr.io and on
the Gitea registry. From v0.0.3 the release also has the probe as downloads for machines without
Docker.

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
