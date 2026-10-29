# 08 — Security, operations, legal

## 1. Threat model (what attacks a PBX on the internet)

| Threat | Example | Controls |
|---|---|---|
| SIP scanners / password guessing | "friendly-scanner", sipvicious hitting 5060 | Generated 24-char SIP passwords; no anonymous endpoint; trunks matched by source address only (`identify_by = ip`, M11-T8); fail2ban/CrowdSec on `security.log`; optional phone ACL (§2.2), browser endpoints included; firewall allow-list |
| **Toll fraud** (the expensive one) | Stolen SIP creds used to call premium international numbers | International route disabled by default; per-user outbound class; outside calls at once per extension (3) and in total (10), Settings → Security; trunk `max_channels`; voip.ms-side international block + balance limits (06 §1); forward targets checked against class; dialed numbers `FILTER`ed before the route's Goto (M11-T8: a "," skipped the class check) |
| Web credential stuffing | Login brute force | argon2id, rate limits, audit log, TOTP for admins (M11) |
| Admin panel bugs | FreePBX 2025–26: an auth bypass + SQL injection, then webshells and stolen trunk passwords (§8) | Admin pages only from listed networks, two-step sign-in required for admins (§8.2, M11-T9) |
| Voicemail PIN guessing | Calling *98 and trying PINs | 6-digit default PIN, `maxlogins=3`, reject trivial PINs (`000000`, `123456`, the extension number repeated). As built (M11-T1): also for PINs changed from the phone's voicemail menu: `externpasscheck = /usr/local/bin/sp-vm-pincheck` (asterisk image, same rules, a unit test keeps it in step with `isTrivialPin`), `minpassword = 4`; the api stores accepted ones from AMI `VoicemailPasswordChange` (`services/vmpin.ts`), otherwise the next config write would put the old PIN back |
| Provisioning leaks | Fetching `/prov/<mac>.cfg` to steal SIP passwords | Per-device Basic auth, 404 on unknown MAC, rate limit + temporary IP block, optional LAN-only |
| Dialplan injection | Name `x); System(...)`; dialed `011…,4` or `…&PJSIP/…` | Sanitizers (03 §2), no `System()` anywhere; at call time, `FILTER` on every `${EXTEN}` from a phone that reaches an app's arguments (M11-T8) |
| SSRF via webhooks | Webhook to `http://127.0.0.1:5038` | Private IP block by default (04 §9), NAT64/6to4 included |
| Stolen backup | Backup file copied | Backups exclude generated plaintext configs; DB secrets are encrypted with `APP_SECRET` (kept in `.env`, not in the backup); mode 0600 |
| AMI exposure | AMI reachable from network | Bound to 127.0.0.1, `permit` 127.0.0.1 only, random secret; only the classes the api uses, and no module in the image that runs host commands (§8.1) |

## 2. Required controls

### 2.1 Network
- Expose only 443/tcp, 5060/udp+tcp (5061/tcp if TLS), 10000–20000/udp.
- Admin guide includes an nftables example that limits 5060/5061 to voip.ms
  server IPs (from the voip.ms wiki list, **verify**) plus `sip.extraAllowedNets`, for setups with no remote phones.
- As built (M11-T2), SIP over TLS:
  - Certificate: `data/tls/fullchain.pem` + `privkey.pem`, mounted read-only into asterisk and the
    api (`TLS_DIR`). `scripts/tls-cert.sh` copies them from the bundled Caddy's storage
    (`data/caddy/caddy/certificates/*/<PUBLIC_HOSTNAME>/`) or from two given paths (certbot), owner
    app UID, key 0600, and runs `module reload res_pjsip.so`. Asterisk 24 re-reads the cert and key on
    that reload (same file names, and only when a file's mtime changed; verified, calls stay up), so
    no restart. It does nothing when the
    files are unchanged: run it daily from cron.
  - Asterisk quietly leaves `transport-tls` out when the files are missing, so `PATCH /api/settings`
    refuses to turn `sip.tlsEnabled` on unless both load and the key matches (node:crypto
    `X509Certificate.checkPrivateKey`), and the dashboard warns (`tls_cert`) when TLS is on and the
    cert is missing or expires within 14 days.
  - `transport-tls` has `verify_server = yes` + `ca_list_file = /etc/ssl/certs/ca-certificates.crt`:
    the provider's certificate is checked (voip.ms: Let's Encrypt, every POP in its SAN list,
    checked 2026-10-19). Asterisk 24.0.0-rc2 checked a **qualify** OPTIONS against the IP instead
    of the host name, which failed on voip.ms ("server identity does not match") and marked the
    contact Unavailable, so TLS trunks had `qualify_frequency = 0` and Test skipped the qualify.
    24.0.0-rc3 fixed it ("Preserve target hostname for qualified OPTIONS destination"): TLS trunks
    are qualified again, and the upgrade check (`tlsQualifyByHostname`, 01 §2) catches it if it
    comes back.
  - Phones over TLS are not provisioned (templates stay UDP); that's for remote phones later.

### 2.2 Phone ACL (setting `sip.restrictPhonesToLocalNets`)
When true, the generator adds to every **desk** extension endpoint (not `-web`, not trunks):
```ini
deny = 0.0.0.0/0.0.0.0
permit = 192.168.0.0/16                ; each network.localNets + sip.extraAllowedNets (deduplicated)
```
Golden case `phone-acl`; `scripts/e2e/m11-t1.mjs` shows Asterisk refusing a REGISTER ("Not match
Endpoint ACL") and accepting it once the network is listed.

Changed in M11-T8: with the setting on, `-web` endpoints get `deny = 0.0.0.0/0.0.0.0` +
`permit = 127.0.0.1/255.255.255.255`. They share the desk phone's password and pjsip accepts an
endpoint on any transport, so `101-web` over UDP from the internet was a way around the ACL.
Browsers reach Asterisk only through the reverse proxy (its HTTP server listens on 127.0.0.1).
`call-test.ts` checks both: `102-web` over UDP from the phones' network is refused, over
WebSocket from 127.0.0.1 it registers. A dev setup whose proxy isn't on Asterisk's host
(Docker without host networking) needs the setting off for the browser phone.

Changed from the first draft (M11-T1): `contact_acl = sp-phone-acl` names a section of **acl.conf**,
not pjsip.conf, and a `type = acl` section in pjsip.conf is res_pjsip_acl's *global* ACL, which would
filter trunks too. Contact-header rules alone are also weak: a phone behind NAT at home advertises a
private address. Source-address `deny`/`permit` on the endpoint is what keeps remote phones out.
Browser phones arrive through the reverse proxy (their source is the proxy), so `-web` endpoints
get the proxy's address only (below). The setting is on Settings → Security, with the provisioning switches (07 §2).

### 2.3 fail2ban / CrowdSec
- `logger.conf` writes `security.log` (01 §3.3).
- Admin guide: fail2ban `asterisk` jail pointed at `./data/asterisk-logs/security.log`, or the CrowdSec
  Asterisk collection with the same log path **(verify collection name)**.
- The api's own auth failures go to stdout JSON with `event: "auth.failed"` and `ip`, so they can be parsed too.

### 2.4 Web
- Security headers on every api response:
  `Content-Security-Policy: default-src 'self'; connect-src 'self' wss://{host}; media-src 'self' blob:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  `Permissions-Policy: microphone=(self), camera=()`.
- HSTS is set by the reverse proxy (Caddy does it by default; nginx example adds `add_header Strict-Transport-Security "max-age=31536000" always;`).
- `TRUST_PROXY=true` → Fastify `trustProxy: '127.0.0.1'` only.
- Rate limits on every route (04 §2.2): `RATE_LIMIT_PER_MINUTE` per client IP, stricter on Test
  buttons; login and a password asked again share the login limiter.
- Admin TOTP (M11): RFC 6238, 30 s, 6 digits, ±1 window, 10 single-use recovery codes (stored hashed).
- As built (M11-T1), TOTP (`auth/totp.ts`, node:crypto only, RFC 6238 test vectors in its test):
  opt-in for admins on **My account** (header → Account): scan the QR or type the key, confirm one
  code, get 10 recovery codes once (`k7m3q-x9tpw`; case and dashes don't matter). Login asks for
  the code only after the password is right (401 `totp_required`, no session); a wrong code is a
  failed login (rate limit, audit). Each 30 s step signs in once (`users.totp_last_step`, updated
  atomically) and each recovery code once (`array_remove` with an `any()` guard). Turning it on or
  off, or making new codes, needs the password. Another admin can turn it off for a lost phone
  (`POST /api/users/:id/reset-two-step`, signs that user out). `scripts/e2e/m11-t1-totp.mjs`.
- As built (M11-T1): the headers come from an `onSend` hook on every response (UI, API, `/prov`);
  `connect-src` also allows `WEBRTC_WS_URL`'s origin when it's set. The dark-mode bootstrap moved
  from an inline `<script>` in `index.html` to `/theme.js`, so `script-src` stays `'self'`.

### 2.5 Files and permissions
- `/etc/asterisk/selfphoneng/*` mode 0640, owner app UID.
- `.env` mode 0600 (install.sh sets it).
- Recordings and voicemail are served only through authenticated api routes, never as static files.

### 2.6 Network diagnostics (owner, 2026-10-21)
System → Diagnostics (`services/diagnostics.ts`, admin only). Every failed or doubtful line says
how to fix it.
- **This server** (`GET /api/system/diagnostics`): public IP set and equal to what
  api.ipify.org sees; `PUBLIC_HOSTNAME`'s A records include it (Cloudflare proxy named in the fix);
  `network.lanIp` inside `network.localNets`; the phone ACL (§2.2) and `provisioning.lanOnly`
  flagged as limits on phones elsewhere; `pjsip show transports` has the enabled transports; the
  RTP range's even ports bound once each, a warning past a quarter taken; whether a probe is set.
- **From the internet** (`POST /api/system/diagnostics/network {mode}`) needs the probe,
  `apps/probe` (no dependencies, its own image `selfphoneng-probe`, `deploy/probe/compose.yml`),
  run outside the network; `network.probeUrl` points at it. A server can't test its own ports:
  hairpin NAT is missing or skips the port forwards, and browsers refuse port 5060.
  - Without Docker (owner, 2026-10-21): each release also attaches `selfphoneng-probe-linux-x64`
    and `-arm64` (Node's single executable applications: esbuild bundles the probe into one CJS
    file, postject injects it into that Node's official binary, checked against nodejs.org's
    SHASUMS256.txt), the bundle itself (`selfphoneng-probe.cjs`, Node 22+) and `SHA256SUMS`.
    `apps/probe/build-binary.mjs`, run in `binary.Dockerfile` with BuildKit's local output (so it
    works on Gitea's runner, where the job's checkout can't be bind-mounted).
    `deploy/probe/selfphoneng-probe.service` runs it under systemd with `DynamicUser` and a
    read-only system. About 45 MB of memory.
  - With `PROBE_KEY` set the probe only answers `Authorization: Bearer <key>` (401 otherwise,
    compared in constant time); without it, it answers anyone and logs a warning at start. The key
    is made in Settings → Network and sent by the api only, never the browser (08 §7 #9).
  - `POST /v1/check {host, tests}`: the probe tests **only the address the request came from** (the
    last X-Forwarded-For entry with `TRUST_PROXY=true`, believed only from a proxy on 127.0.0.1
    or ::1, where the probe then listens by default; 08 §7 #4), so it can't be aimed at anyone else; 20
    tests at most, 10 checks per address per 10 minutes, 4 s per test.
  - Quick: HTTP 80, HTTPS 443 `/healthz` (status and certificate), SIP OPTIONS over UDP (and TCP
    when on) to `sip.udpPort`. Complete adds SIP over TLS (when on), a WebSocket upgrade on `/ws`
    (protocol `sip`), and up to four even ports of the RTP range: the api binds them and the probe
    sends a token to each.
  - The answer's `ip` is checked too: a private one means the probe is inside the network; another
    public one than `network.publicIp` means a VPN or a changed address.
- The RTP range comes from `RTP_PORT_START`/`RTP_PORT_END` (api env, default 10000–20000; 01 §3.6).

## 3. Operations

### 3.1 Install / update
- `scripts/install.sh` (01 §1.3).
- Docker only (owner, 2026-10-21): SelfPhoneNG never supports a bare-metal install.
- Database changes ship in the image: the api runs pending migrations as it starts. Before it does,
  it backs up (`backupBeforeMigrate`: database, voicemail, custom sounds, MOH; no recordings; prunes
  nothing) and stops, leaving the database alone, if that fails; `SKIP_BACKUP_BEFORE_MIGRATE=true`
  overrides. Any other one-off upgrade step goes in the image the same way, so pulling the new
  image is the whole update for every install. What can't (a PostgreSQL major version, a new stack
  setting) goes in the changelog under the version that needs it.
- `scripts/update.sh`, for compose installs (the folder `install.sh` set up) only: checks (clean
  checkout, 3 GB free, no calls, the changelog, new `.env.example` keys), a backup
  (`node dist/backup-cli.js` in the running api), Asterisk logs gzipped (kept 90 days), the
  release's images built while the old ones run, `up -d`, then a check (healthz, `/app/VERSION`,
  Asterisk fully booted, trunks registered before still are). On a failed check: the previous
  commit rebuilt and, if the migration count changed, `restore.sh` with the api's pre-migration
  backup. Logs in `data/update-logs/`. Image-based installs (Portainer) change the tag and redeploy
  (admin guide, maintenance.md).
- Version: `package.json` version at the root, exposed at `/api/system/status`. Semver. `CHANGELOG.md` kept by hand.
- Releases (owner, 2026-10-20; first one v0.0.1): container images are built only when a release
  is published, by `.github/workflows/release.yml`, which runs on Gitea and on the GitHub mirror,
  each pushing to its own registry: `ghcr.io/<owner>/selfphoneng-{api,asterisk}` (the job's
  `GITHUB_TOKEN`) and `<gitea host>/<owner>/selfphoneng-{api,asterisk}` (repository secrets
  `REGISTRY_USER` + `REGISTRY_TOKEN`, a personal access token with `write:package`: Gitea's job
  token can't push packages). Tags: the version, plus (pre-release: `dev`; otherwise)
  `<major>.<minor>` and `latest`. The job fails unless the tag is `v` + the root package.json
  version, and checks the images (every api module loads, `/app/VERSION`, `asterisk -V`) before
  pushing. To release: set the version in all four package.json files, add a `CHANGELOG.md`
  entry, commit, push, then create release `vX.Y.Z` on Gitea (it mirrors to GitHub; create the
  release there too for ghcr.io). The asterisk image is built with `ASTERISK_UID/GID` 1000.
  `docker-compose.yml` still builds locally; pulling the published images is a later step.
- Asterisk security releases: bump `ASTERISK_VERSION` in the Dockerfile and rebuild. The admin guide explains how.

### 3.2 Monitoring
- `GET /healthz` for an external monitor (Uptime Kuma etc.): 200 / 503 + JSON reasons.
- Emails to admins: trunk down > 5 min, disk < 10%, public IP changed, backup failed.
- Logs: `docker compose logs api`, `./data/asterisk-logs/messages.log`.

### 3.3 Troubleshooting page in the admin guide (M11)
Must cover: one-way audio (NAT/publicIp/SIP ALG/RTP ports), trunk won't register (credentials, server,
IP whitelist when IP auth, firewall), inbound calls don't arrive (DID routing + POP), browser softphone won't
register (WSS proxy path `/ws`, certificate, microphone permission), voicemail emails not sent (SMTP test), and
how to use `/admin/system` CLI views and `pjsip set logger on` (via `docker compose exec asterisk asterisk -rx`).

## 4. Licensing compliance
- Our code: AGPL-3.0-or-later. Add `LICENSE`, SPDX headers, and an About page (`/admin/system` → About) listing
  the license and a link to the source repository (AGPL requires offering source to network users).
  As built (owner, 2026-10-20): `/about` needs no sign-in (linked from the login page, My phone and System). The
  api image carries the exact source it was built from: `apps/api/Dockerfile` tars the build context (minus
  `.dockerignore`: no `.env`, `data/`, `node_modules`, build output or `.git`) into `/app/selfphone.tar.gz`
  before installing anything, with `VERSION` from the root package.json. "Code v<version>" downloads it
  (`GET /api/about/source`, `selfphone.tar.gz`, top folder `selfphoneng-<version>/`). Outside Docker there is
  no archive and the page says so. The repository link is general context. The ringtone is synthesized
  (WebAudio), so there's no sound file to credit.
- Asterisk: GPL-2.0, runs as a separate program. We don't link to it, so there's no license conflict.
- Asterisk core/extra sounds and opsound MOH: CC-BY-SA. Credit them on the About page.
- Ringtone: CC0, documented in `apps/web/public/sounds/SOUNDS-LICENSE.md`.
- No closed-source codecs (AGENTS rule 4).

## 5. Legal features (not legal advice; the admin guide says to check local law)
- **Call recording consent:** US federal law and most states are one-party consent, but several states
  (e.g. California, Florida, Illinois, Maryland, Massachusetts, Montana, New Hampshire, Pennsylvania, Washington)
  require all parties to consent. When any recording is enabled, the Recording settings tab shows this notice and
  strongly suggests setting `recordings.announcementSoundId`. The setup wizard doesn't turn recording on.
- **E911 / Kari's Law / RAY BAUM'S Act:** see 06 §6.
- **Data retention:** retention settings for recordings and voicemail (04 §8). Deleting a user offers
  "delete their voicemail and recordings too".

## 6. Security review (M11-T8, 2026-10-20)

Two passes: this file's §1 table row by row against the code, and a separate review agent that
hadn't written the code (read-only, told to prove each finding end to end). Each finding below was
reproduced before the fix where a test could show it, and that test now passes.

| # | Severity | Finding | Fix | Proof |
|---|---|---|---|---|
| 1 | Critical | SIP allows "," in a dialed number. `Goto(sp-route-…,${EXTEN},1)` with `011…,4` became `Goto(sp-route-…,011…,4,1)`, starting past the class check: any extension, even class internal, could call abroad on the default `011.` route | `${FILTER(0-9*#+,…)}` in every `sp-or-*` Goto (03 §6.12) | `trunk-test.ts` dials `01144207946095,4` with no class: failed, now hears ss-noservice |
| 2 | High | `-web` endpoints (desk phone's password, any transport) were not covered by the phone ACL | ACL on `-web`: 127.0.0.1 only (§2.2) | `call-test.ts` |
| 3 | Medium | "&" in a dialed number added a second Dial target, outside the trunk channel limit | the same FILTER (#1) | golden files |
| 4 | Medium | IVR direct dial included `sp-local-numbers`: outside callers could page the office (and listen, duplex) or take a parked call | `sp-ivr-direct` (03 §6.9) | `ivr-direct.test.ts` |
| 5 | Medium | The public source archive was the build context minus a denylist: a backup or key dropped in the repo folder would be served to anyone | `.dockerignore` is an allowlist | built the image with a planted `selfphoneng-*.tar.gz`: not in the archive |
| 6 | Low | Trunk endpoints (no inbound auth) matched by From username: `From: trunk-<id>` from anywhere rang phones | `identify_by = ip` on trunks (03 §5.3) | `trunk-test.ts` (a third Asterisk plays the attacker): failed, now refused |
| 7 | Low | CSRF check on raw `req.url`: `/%61pi/…` is routed to /api/… without the header | check the matched route | `auth.test.ts` |
| 8 | Low | Linphone setup tokens (credentials) in the request log | req serializer masks them | `log-url.test.ts` |
| 9 | Low | `/api/live` kept a socket's rights after logout, deactivation or demotion; no Origin check | foreign Origin → 4403; session re-checked every 30 s → 4401 | `live.test.ts` |
| 10 | Low | `*45<queue>` and `**<ext>` put raw dialed text into app arguments | FILTER to digits (03 §6.13) | golden files |
| 11 | Low | pg_dump got the DB password on its command line (visible to `ps` on the host) | `PGPASSWORD` in its environment | pg_dump run with the new URL form |
| 12 | Low | Webhook private-address block missed 192.0.0.0/24, 198.18.0.0/15, NAT64, 6to4 | added | `integrations.test.ts` |
| 13 | Medium | No limit on simultaneous outside calls (trunk `max_channels` empty by default): a stolen password could run many international calls at once | Owner's call (2026-10-20): `calls.maxPerExtension` (3) and `calls.maxTotal` (10), `GROUP_COUNT` in each `sp-route-*` | `trunk-test.ts` (limits 1 and 2: a 2nd call from 101's phone and a 3rd in total refused; with both 0 the same test fails), `call-limits.test.ts` |

Checked and sound (both passes): no `sql.raw` or string-built SQL; every admin route has
`requireAdmin`, and recordings, voicemail, `/api/me/*` check ownership; generated config can't be
injected (newline, `;`, `[section]`, `${…}`); file serving is rooted, uploads go through ffmpeg
without a shell; CSV export escapes formulas; no `dangerouslySetInnerHTML`; sessions and API tokens
stored as sha256; AES-256-GCM with a random IV per value; AMI, Asterisk HTTP and the api listen on
127.0.0.1 only; webhooks check addresses at connect time (no DNS rebinding), follow no redirects.

Fixed after the review (owner, 2026-10-21):
- `asterisk/conf/modules.conf` doesn't load `app_system`, `func_shell`, `app_disa`, `res_agi` or
  `app_externalivr`. Nothing uses them, but they are what a dialplan injection would reach for
  (`SHELL()` runs host commands). `pnpm test:asterisk` passes without them.
- Turning two-step sign-in on asks for the password again, like turning it off (`totp.test.ts`).
- `*97`/`*98`: one voicemail login at a time per phone and 10 an hour (`sp-sub-vmlimit`, AstDB
  `SP/VMLOGIN/<ext>` = `<UTC hour>:<count>`), each with 3 PIN tries (`voicemail-test.ts`).
- `/prov`: an unknown MAC gets the same 401 as a known one, so the answers don't tell which MACs
  exist; with credentials it counts as a failure (`devices.test.ts`).
- The login limiter forgets keys past every window, swept at most once a minute
  (`login-limiter.test.ts`).

## 7. Security review 2 (2026-10-28)

Everything since §6 (`8d5475c..`): contacts and Contrack, single sign-on, call reports, local AI,
spam check, the mobile app's pairing, my reports and spam reports. Two passes again: one against
the code by the author, and an independent review agent (read-only, told to prove each finding
end to end). Each fix came with a test that failed before it and passes now. Nothing Critical or
High.

| # | Severity | Finding | Fix | Proof |
|---|---|---|---|---|
| 1 | Medium | A directory sign-in matched by email a user who signs in with OpenID only. Where people can edit their own `mail`, Mallory set hers to the victim's and her own directory password opened the victim's account | the email match also needs no connected account of any kind (12 §4.3 step 2) | `directory-signin.test.ts` |
| 2 | Medium | An OpenID sign-in matched by verified email an admin, or a user who signs in through the directory (no password, no OpenID account yet): a provider account with that email got their session, admin included | not an admin, and no connected account of any kind (12 §3.3 step 2) | `oidc.test.ts`, both key types |
| 3 | Medium, privacy | Everyone whose phone **rang** counted as on the call: a ring group or queue member who didn't answer could play a coworker's recording, read its transcript, and got its summary in their call report email and on their Contrack timeline. The audio part predates §6 | `ON_THE_CALL` (`services/cdr.ts`): only the `caller` and `answered` roles, in `mayHear`, `/api/me/calls` (no `recordingId`), the call report and the timeline | `recordings.test.ts`, `call-reports.test.ts`, `contrack.test.ts` |
| 4 | Low | The probe with `TRUST_PROXY=true` believed any X-Forwarded-For and listened on every address: reached directly, anyone could have it test any address and ports | X-Forwarded-For only from 127.0.0.1 or ::1; `HOST` defaults to 127.0.0.1 with `TRUST_PROXY=true` (§2.6) | `probe.test.ts` |
| 5 | Low | A user could swap their directory account for another one they know the password of (a shared mailbox): the leaver check then followed the wrong account | `POST /api/me/identities/ldap` → 409 `connected_other` when a different one is connected; an admin disconnects first (12 §4.3) | `directory-signin.test.ts` |
| 6 | Low, privacy | The `voicemail.new` webhook carried the transcript, though webhooks leave the server and 10 §1 says transcripts don't | the webhook has no `transcript` (04 §9) | `voicemail.test.ts` |
| 7 | Low | Contrack's saved company token went to any address: Test with another URL, or saving a new URL, sent it there (SMTP, LDAP and OpenID already refused) | the saved token only for the saved address; a new address needs it typed again and clears everyone's own token (11 §4.3) | `contrack.test.ts` |
| 8 | Low | The OpenID connect callback wasn't tied to the browser that asked: a planted `sp_oidc` (a sibling subdomain can set it) connected the victim's provider account to the attacker's user | the callback's own session must be the one in `sp_oidc`, else `expired` (12 §3.3) | `oidc.test.ts`, both key types |
| 9 | Low | Anyone who found a probe could use it (owner's idea after #4): to test their own address, and spend its per-address limits | an optional key: Settings → Network → Generate key, set as the probe's `PROBE_KEY`; the api sends it as a Bearer token, encrypted at rest, dropped when the probe address changes. Without a key the probe stays open (owner, 2026-10-28) and Diagnostics warns, strongly recommending one (§2.6) | `probe.test.ts`, `diagnostics.test.ts` |

The independent agent found 1, 2, 4, 5 and 8, the author 3; both found 6 and 7; 9 was the
owner's idea. The agent had
checked the recording rule and called it sound: it's the same rule as the audio, which §6 also
passed.

Checked and sound (both passes): every new route's guard and ownership check (contacts and
sharing, spam reports, my reports, caller check, mobile devices); a paired phone is never an admin
and can't make pairing codes, and codes are single-use; OpenID PKCE, state, nonce, `safeNext` and
encrypted provider tokens; LDAP filter escaping and no empty binds; the caller-name lookup only
for Asterisk on this machine with its token; phonebook XML and timeline HTML escaped, report
emails plain text; AI and Contrack addresses literal local IPs with redirects refused; the spam
provider key kept out of errors; every new raw SQL parameterized; no secret in any GET.

## 8. After the FreePBX campaign (owner, 2026-10-29)

INJ3CTOR3 got into internet-facing FreePBX through its admin panel: CVE-2025-57819 (Endpoint
module, an auth bypass + SQL injection, no sign-in needed) and CVE-2025-64328 (filestore, command
injection after sign-in). It left PHP webshells, cron jobs and backdoor accounts, then copied out
the trunk, AMI, database and mail passwords. With the trunk password it registers to the provider
from its own machine, so the calls skip the PBX entirely. Our stack has no PHP and no shell in
reach of the web (§6, §7). Two changes follow.

### 8.1 AMI: only the classes we use (as built)

| Class | Actions the api sends | Events the api reads |
|---|---|---|
| `system` | DBPut, DBDel, DBDelTree, PJSIPShowContacts, PJSIPShowEndpoint, PJSIPShowRegistrationsOutbound, PJSIPQualify, CoreShowChannels | ContactStatus, Registry |
| `call` | Redirect, Hangup, ParkedCalls, ExtensionStateList | Newchannel, Newstate, NewCallerid, NewConnectedLine, BridgeEnter/Leave, Hold/Unhold, Hangup, ParkedCall, ParkedCallTimeOut, ParkedCallGiveUp, UnParkedCall, ExtensionStatus, MessageWaiting |
| `command` | Command (reloads, `core show uptime`, `core restart`, `pjsip show transports`) | |
| `originate` | Originate | |
| `agent` | QueuePause | QueueCaller*, QueueMember*, AgentConnect |
| `user` | VoicemailMove, VoicemailRemove | UserEvent, VoicemailPasswordChange |
| `cdr` | | Cdr |
| `dialplan` | | VarSet, Newexten |

Ping, Login, Logoff and QueueStatus need no class. Action classes come from `manager show command`
on 24.0.0-rc3; event classes from Asterisk's AMI event docs.

Measured on 24.0.0-rc3: an action is allowed when the user has **any one** of its classes. So
`system`, which DB* and PJSIP* need, still allows GetConfig (any config file, trunk passwords
included) and ModuleLoad, and ModuleLoad loaded `func_shell.so` past `noload` in modules.conf
(`Command: module load` does the same). Class limits are no barrier (Asterisk's docs say not to
rely on them). What dropping the rest takes away is `config`: UpdateConfig and CreateConfig, a
way to write a trunk into a file the admin panel never shows. The barrier is the image itself:
`asterisk/Dockerfile` deletes `app_system`, `func_shell`, `app_disa`, `res_agi` and
`app_externalivr`, so nothing is left for ModuleLoad to load. The AMI secret is still the whole
key (Originate is enough for toll fraud), so AMI stays on 127.0.0.1.

The Asterisk tests mount the real template with only `bindaddr` and `permit` opened
(`test/asterisk/manager-conf.ts`), so a class the api needs and the template lacks fails them.

### 8.2 Admin access (to build: M11-T9)

Both FreePBX bugs were reached through an admin panel open to the internet, and Sangoma's first
advice was to block it. SelfPhoneNG serves the admin pages, the user portal and the browser
phone's WebSocket on one host and port, so a firewall can't keep one out and let the others in. Two settings on
Settings → Security, both off by default (today's behaviour):

**`auth.adminAllowedNets`**: CIDR list, IPv4 and IPv6 (`z.union([z.cidrv4(), z.cidrv6()])`).
Empty means admin from anywhere.
- `requireAuth` (`auth/guards.ts`), once `req.user` is set: an admin whose `req.ip` is outside the
  list, and isn't 127.0.0.1 or ::1, gets `req.user = { ...user, role: 'user' }` and
  `req.adminElsewhere = true`, the same way a paired phone is never an admin (13 §2). Every role
  check after that sees a user: `requireAdmin`, recordings (`role === 'admin'`), the OpenID
  `next` default. Sessions and API tokens alike (a token acts as its admin, 04 §2.3).
- Matching: node:net `BlockList`, as `/prov` does (`isLocal` in `routes/provisioning.ts`, which
  becomes the shared `inNets(ip, nets)`), with `::ffff:`-mapped IPv4 unwrapped. The list is read
  with `getSetting` only when the user is an admin (one row by key).
- `/api/live` (`live/hub.ts`) reads the session itself: `admin` at connect uses the same rule
  with the socket's `req.ip`. The 30 s re-check compares the same way and closes with 4401 when
  the list changes under it.
- Two-step routes (`/api/auth/totp/*`) check the stored role, not the downgraded one: an admin
  away from the office can still look after their own sign-in.
- Signing in works from anywhere. An admin outside the list gets their own portal (My phone,
  voicemail, calls). `GET /api/auth/me` adds `adminElsewhere: true`, and the web app shows
  one line where the admin menu would be: "Admin pages open only from an allowed network
  (Settings → Security)."
- 127.0.0.1 and ::1 always count as allowed. That's the way back in when the list is wrong:
  `ssh -L 8080:127.0.0.1:8080 <server>`, then `http://localhost:8080` (browsers keep `Secure`
  cookies on localhost). The admin guide shows it.
- `PATCH /api/settings` refuses, like `sip.tlsEnabled` (§2.1):
  - 409 `would_lock_out` when the new list isn't empty and the request's own address isn't in it
    (loopback counts as in);
  - 409 `trust_proxy_off` when `req.ip` is loopback and the request has `X-Forwarded-For`: behind
    a proxy without `TRUST_PROXY=true` every request looks local and the list would do nothing.
- The form offers "Add the local networks" (`network.localNets`) and the address you're using now.
  Its help text: integrations calling admin routes with an API token need their address listed
  too; a VPN into the office network is the usual answer for working away.
- Diagnostics (§2.6): a warning when the list is empty ("Admin pages open from anywhere");
  otherwise the list.

**`auth.requireAdminTotp`**: boolean.
- When on, an admin without two-step sign-in (`totpSecretEnc` null) whose session came from a
  password or the directory gets a session that works like `must_change_password` (04 §2.2):
  every route outside `/api/auth/*` → 403 `totp_setup_required`, and the web app sends them to
  My account → Two-step sign-in. The check reads the user row on each request, so the session
  turns normal once two-step is on. `mustChange` in `auth/sessions.ts` grows this case, so
  `/api/live` follows it too.
- Exempt: OpenID sessions (`sessions.method = 'oidc'`, the provider does the second factor, 12)
  and API tokens (made by an admin who signed in).
- Turning it on needs the saving admin to have two-step on (409 `totp_first`).
- "Turn off for a lost phone" (`POST /api/users/:id/reset-two-step`) still works: that admin is
  sent to set it up again at their next sign-in.

Tests (each fails without its rule): an admin outside the list gets 403 on an admin route and
200 on `/api/me`, from 127.0.0.1 and from inside it is an admin (IPv4, IPv6, `::ffff:`); an API
token the same; `/api/live` gives `admin: false` outside; a recording of someone else refused
outside; `would_lock_out` and `trust_proxy_off`; `totp_setup_required` until two-step is on,
then 200; an OpenID session exempt; `totp_first`.

Setup (owner, 2026-10-29): the first-run wizard offers both, switched on, with the list
prefilled from the local networks (05 §2.1 step 3a). The settings' own defaults stay off, so an
update changes nothing on an existing install.

### 8.3 Fraud alerts (owner, 2026-10-29; M11-T10)

Until now an admin learned of toll fraud from voip.ms's balance alert or the bill. Fraud with a
stolen trunk password leaves no call in our records at all: the calls never touch the PBX. Three
checks, each an email to every admin plus a `warning` system event; all three are on by default
and on Settings → Security, "Fraud alerts". In `services/fraud.ts`, run from `jobs.ts`.

- **`riskyCallWatch`** (every minute; `alerts.riskyCalls`): outside calls the PBX placed, new
  since the last run (`calls.created_at`), to a number `riskyDestination` calls risky: `011…`
  (international), area code 900 or exchange 976 (premium), and the NANP area codes outside the
  US and Canada, which are dialed like a domestic call but billed at international rates and are
  the usual one-ring-scam targets: 242 246 264 268 284 345 441 473 649 658 664 721 758 767 784
  809 829 849 868 869 876 **(verify the list)**. One email per run listing the calls. The
  cursor starts when the api starts: calls made while it was down have no row anyway (their CDR
  events are lost).
- **`providerCallCheck`** (every 15 minutes; `alerts.providerCalls`; voip.ms trunks with an API
  login, 06 §5.1): voip.ms's call records for the trunk's sub-account (`getCDR`,
  `account = trunks.username`, `timezone = 0` so times are UTC) from 2 hours to 10 minutes ago.
  Records to one of our DIDs are incoming and skipped. Every other record must match an
  outbound `calls` row: same last 10 digits of the number, started within 5 minutes. One that
  doesn't is a call voip.ms billed that this PBX didn't make: the email lists them and says to
  change the sub-account password, turn on its IP restriction (06 §1), and that a call made while
  the api was restarting, or by another device on the same sub-account, also shows here. Each
  voip.ms record is reported once (by `uniqueid`, time and number, kept in memory for 3 hours).
- **`balanceWatch`** (every 15 minutes, same API logins; `alerts.balanceDropPerHour`, 0 = off):
  the balance (`getBalance`) more than that amount below its highest in the last hour → one email
  per hour. It catches what the call check can't: another sub-account, or one made with a stolen
  API password. A deposit only raises the balance, so it never alerts.

An API error is logged (`warn`), not emailed: Reports already shows why the balance can't be read.
