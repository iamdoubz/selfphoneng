# Changelog

Versions follow [semver](https://semver.org). Each release's container images are built from its
tag (08 §3.1): `selfphoneng-api` and `selfphoneng-asterisk`, on ghcr.io and on the Gitea registry.

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
