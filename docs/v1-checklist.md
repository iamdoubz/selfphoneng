# Ready for v1 checklist

v1.0 ships when every box is ticked. It gathers the roadmap's definition of done
([09](spec/09-roadmap.md)) and its open real-hardware checks, plus the security leftovers (08 §6).
Tick a box only with proof: a date and what was seen.

## Built

- [x] Milestones M0–M11 built and tested (simulated phones and a simulated voip.ms).
- [x] Security review (M11-T8), with an independent review (08 §6).

## Real voip.ms account (M3)

- [x] The trunk shows **Registered** in the UI (2026-10-21: green, voip.ms, the sub-account at
      its POP).
- [x] A mobile → DID call rings a phone. 2026-10-21: DID → digital receptionist → browser
      phone; the DID came in the Request-URI. Still to do: write that down in 06 §3.
- [x] An outbound call shows the DID as caller ID on the mobile (2026-10-21, owner).
- [ ] Write down in 06 §4 whether per-call caller ID (Remote-Party-ID) is honored.

## Real phones (M8, M10)

- [x] Linphone on a real phone registers by scanning the QR (2026-10-20, iPhone).
- [x] An incoming call rings that Linphone while the app is open (2026-10-21, v0.0.2: DID →
      receptionist → 100 rings the iPhone).
- [ ] A factory-reset Yealink pointed at the setup URL registers with the right name and BLF keys.
- [ ] A Grandstream gets its keys the same way.
- [ ] Paging auto-answers on a real Yealink or Grandstream.

On hold until the owner has the phones (2026-10-21).

## Someone else installs it (M11)

- [ ] An outside tester follows only the admin guide and gets inbound and outbound calls working
      on a fresh VM.
- [ ] A backup restores on a second VM.

On hold (2026-10-21).

## A week on the owner's server

- [ ] 7 days handling real calls with no crash or restart of the api or Asterisk.
- [ ] Nightly backups restore cleanly.

In progress on the owner's server (v0.0.2, from 2026-10-21).

## Updating

Docker only, never bare metal (owner, 2026-10-21).

- [x] The api backs up before it changes the database, and stops if it can't (2026-10-21).
- [x] `scripts/update.sh` for compose installs, and the admin guide's "Updating" section for
      compose and Portainer (2026-10-21).
- [ ] A real compose install with the bundled Caddy updated with `scripts/update.sh`, with calls
      and backups.
- [ ] The owner's Portainer stack updated to a release that changes the database.

## Security leftovers (08 §6)

Owner's decision (2026-10-21): fix all of them. Each is in 08 §6 with its test.

- [x] Asterisk no longer loads `app_system`, `func_shell`, `app_disa`, `res_agi` or
      `app_externalivr`; `pnpm test:asterisk` passes.
- [x] Turning two-step sign-in on asks for the password again.
- [x] `*97`/`*98`: one voicemail login at a time per phone, 10 an hour.
- [x] An unknown MAC answers `/prov` like a known one (401).
- [x] The login limiter forgets old entries.

## The release

- [ ] Version 1.0.0 in every `package.json`, and a v1.0.0 entry in the [changelog](../CHANGELOG.md).
- [ ] The release builds and pushes images to both the Gitea registry and ghcr.io. (Gitea works.
      ghcr.io: the api image pushes; the asterisk package exists, empty, and refuses the push.)

## Not needed for v1

More SIP providers (Telnyx, Flowroute, Twilio), SMS, push notifications for phone apps, and the
M12 list in the roadmap.
