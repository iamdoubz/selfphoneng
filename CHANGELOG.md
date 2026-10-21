# Changelog

Versions follow [semver](https://semver.org). Each release's container images are built from its
tag (08 §3.1): `selfphoneng-api` and `selfphoneng-asterisk`, on ghcr.io and on the Gitea registry.

## Unreleased

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
