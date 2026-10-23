# 0003 — Contrack for "Robust" contacts

Owner, 2026-10-23: contacts come in two kinds (spec 11), and the robust one is
[Contrack](https://github.com/arvarik/contrack), a self-hosted contact and relationship manager.
It already does what a phonebook would take years to grow into: notes, timelines, reminders,
relationship tracking, duplicate merging, search, imports from Google, Apple and LinkedIn, and
CardDAV sync. It's allowed because it is open source (AGPL-3.0-only) and runs as **its own
program** (`deploy/contrack/compose.yml`, image pinned to 2.0.2) that SelfPhoneNG talks to over
HTTP on 127.0.0.1: none of its code is in our dependency tree, and there is no license mixing.
The risk is a young project with one maintainer: we use seven of its routes (`/healthz`,
`/api/contacts` list and create, and in C5 the timeline routes), pin the version, and
`apps/api/test/contrack.test.ts` keeps a fake of exactly those routes, and
`apps/api/test/contrack-live.test.ts` runs the same flows against a real Contrack
(`CONTRACK_LIVE_URL`, a fresh container; passed against 2.0.2 on 2026-10-23). A new Contrack
version is a deliberate update: read its CHANGELOG, run the live test against it, bump the tag.
