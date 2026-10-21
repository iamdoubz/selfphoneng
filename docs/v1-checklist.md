# Ready for v1 checklist

v1.0 ships when every box is ticked. It gathers the roadmap's definition of done
([09](spec/09-roadmap.md)) and its open real-hardware checks, plus the security leftovers (08 §6).
Tick a box only with proof: a date and what was seen.

## Built

- [x] Milestones M0–M11 built and tested (simulated phones and a simulated voip.ms).
- [x] Security review (M11-T8), with an independent review (08 §6).

## Real voip.ms account (M3)

- [ ] The trunk shows **Registered** in the UI.
- [x] A mobile → DID call rings a phone. 2026-10-21: DID → digital receptionist → browser
      phone; the DID came in the Request-URI. Still to do: write that down in 06 §3.
- [ ] An outbound call shows the DID as caller ID on the mobile. Write down in 06 §4 whether
      per-call caller ID (Remote-Party-ID) is honored.

## Real phones (M8, M10)

- [x] Linphone on a real phone registers by scanning the QR (2026-10-20, iPhone).
- [ ] An incoming call rings that Linphone while the app is open (fixed in v0.0.2, needs
      checking on the server).
- [ ] A factory-reset Yealink pointed at the setup URL registers with the right name and BLF keys.
- [ ] A Grandstream gets its keys the same way.
- [ ] Paging auto-answers on a real Yealink or Grandstream.

## Someone else installs it (M11)

- [ ] An outside tester follows only the admin guide and gets inbound and outbound calls working
      on a fresh VM.
- [ ] A backup restores on a second VM.

## A week on the owner's server

- [ ] 7 days handling real calls with no crash or restart of the api or Asterisk.
- [ ] Nightly backups restore cleanly.

## Updating

- [ ] `scripts/update.sh` written, reviewed and tested on a real server: updating a running
      install, with calls, backups and the bundled Caddy.
- [ ] The admin guide's "Updating" section matches it.

## Security leftovers (08 §6)

- [ ] Asterisk no longer loads `app_system`, `func_shell`, `app_disa` and `res_agi`; checked with
      `pnpm test:asterisk`.
- [ ] Owner decision, fix or accept each:
  - [ ] Turning two-step sign-in on doesn't ask for the password again.
  - [ ] `*98` allows 3 PIN tries per call, with no limit on calls.
  - [ ] A known MAC answers `/prov` with 401, an unknown one with 404.
  - [ ] The login limiter's memory grows with the number of distinct emails tried.

## The release

- [ ] Version 1.0.0 in every `package.json`, and a v1.0.0 entry in the [changelog](../CHANGELOG.md).
- [ ] The release builds and pushes images to both the Gitea registry and ghcr.io.

## Not needed for v1

More SIP providers (Telnyx, Flowroute, Twilio), SMS, push notifications for phone apps, and the
M12 list in the roadmap.
