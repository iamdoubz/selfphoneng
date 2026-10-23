<p align="center">
  <img src="apps/web/public/logo-512.png" alt="SelfPhoneNG" width="220">
</p>

# SelfPhoneNG

A fully open source, self-hosted business phone system. Bring your own SIP trunk and numbers
(reference provider: voip.ms). Built on Asterisk 24 + TypeScript + PostgreSQL 18, runs in Docker.

**Status:** pre-1.0 (v0.0.7), for testing. See [what's left for v1](docs/v1-checklist.md).

## What it does today

- **Phones:** users and extensions, desk phones (Yealink, Grandstream) set up automatically, a
  browser phone, and Linphone set up by scanning a QR code.
- **Numbers:** voip.ms trunks (registration or IP auth, UDP/TCP/TLS + SRTP), phone numbers,
  outbound rules with calling permissions, 911 with E911 caller ID and alerts.
- **Call flows:** digital receptionists, office hours and holidays, ring groups, queues, parking,
  pickup, conference rooms, paging and intercom, music on hold.
- **Voicemail** with email (and transcripts by local AI), **call history**, **recordings**, a **live dashboard** (listen,
  whisper, barge) and reports.
- **Running it:** updates (`scripts/update.sh` for compose installs; a backup before every
  database change), backups and restore, background health checks, webhooks and API tokens,
  two-step sign-in for admins, limits on outside calls at once.

## Wanted

- More SIP providers: **Telnyx, Flowroute and Twilio** first.
- More local AI: call transcripts and summaries, typed prompts, type-to-speak, an AI
  receptionist ([spec](docs/spec/10-ai.md)).
- Analog phone adapters set up automatically: **Grandstream HT802 V2** first (two ports, a dial
  plan from your numbers), then Cisco ATA 191/192 and SPA112/122. Today they're set up by hand
  ([how](docs/admin-guide/ata.md)).
- SMS (built for voip.ms, parked until wanted).
- Push notifications, so phone apps ring in the background.
- Text-to-speech prompts, recording prompts by phone, a queue wallboard, Polycom phones.

## Docs

- [Admin guide](docs/admin-guide/README.md): install, [voip.ms setup](docs/admin-guide/voipms.md),
  [network and firewall](docs/admin-guide/network.md), [E911 and recording law](docs/admin-guide/legal.md),
  [troubleshooting](docs/admin-guide/troubleshooting.md), [updating and backups](docs/admin-guide/maintenance.md),
  [analog phones (ATAs)](docs/admin-guide/ata.md), [local AI](docs/admin-guide/ai.md)
- [Changelog](CHANGELOG.md)
- [Ready for v1 checklist](docs/v1-checklist.md)
- Writing code (human or AI): start with [`AGENTS.md`](AGENTS.md), then the
  [spec](docs/spec/00-overview.md) and the [roadmap](docs/spec/09-roadmap.md)

License: AGPL-3.0-or-later.
