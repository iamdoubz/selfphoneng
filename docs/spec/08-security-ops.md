# 08 — Security, operations, legal

## 1. Threat model (what attacks a PBX on the internet)

| Threat | Example | Controls |
|---|---|---|
| SIP scanners / password guessing | "friendly-scanner", sipvicious hitting 5060 | Generated 24-char SIP passwords; no anonymous endpoint; trunks matched by source address only (`identify_by = ip`, M11-T8); fail2ban/CrowdSec on `security.log`; optional phone ACL (§2.2), browser endpoints included; firewall allow-list |
| **Toll fraud** (the expensive one) | Stolen SIP creds used to call premium international numbers | International route disabled by default; per-user outbound class; outside calls at once per extension (3) and in total (10), Settings → Security; trunk `max_channels`; voip.ms-side international block + balance limits (06 §1); forward targets checked against class; dialed numbers `FILTER`ed before the route's Goto (M11-T8: a "," skipped the class check) |
| Web credential stuffing | Login brute force | argon2id, rate limits, audit log, TOTP for admins (M11) |
| Voicemail PIN guessing | Calling *98 and trying PINs | 6-digit default PIN, `maxlogins=3`, reject trivial PINs (`000000`, `123456`, the extension number repeated). As built (M11-T1): also for PINs changed from the phone's voicemail menu: `externpasscheck = /usr/local/bin/sp-vm-pincheck` (asterisk image, same rules, a unit test keeps it in step with `isTrivialPin`), `minpassword = 4`; the api stores accepted ones from AMI `VoicemailPasswordChange` (`services/vmpin.ts`), otherwise the next config write would put the old PIN back |
| Provisioning leaks | Fetching `/prov/<mac>.cfg` to steal SIP passwords | Per-device Basic auth, 404 on unknown MAC, rate limit + temporary IP block, optional LAN-only |
| Dialplan injection | Name `x); System(...)`; dialed `011…,4` or `…&PJSIP/…` | Sanitizers (03 §2), no `System()` anywhere; at call time, `FILTER` on every `${EXTEN}` from a phone that reaches an app's arguments (M11-T8) |
| SSRF via webhooks | Webhook to `http://127.0.0.1:5038` | Private IP block by default (04 §9), NAT64/6to4 included |
| Stolen backup | Backup file copied | Backups exclude generated plaintext configs; DB secrets are encrypted with `APP_SECRET` (kept in `.env`, not in the backup); mode 0600 |
| AMI exposure | AMI reachable from network | Bound to 127.0.0.1, `permit` 127.0.0.1 only, random secret |

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
    checked 2026-10-19). Asterisk 24.0.0-rc2 checks a **qualify** OPTIONS against the IP instead of
    the host name, which fails on voip.ms ("server identity does not match") and marks the contact
    Unavailable, so TLS trunks get `qualify_frequency = 0` and Test skips the qualify; REGISTER and
    INVITE verify the name correctly. Re-check on Asterisk upgrades.
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
  - `POST /v1/check {host, tests}`: the probe tests **only the address the request came from** (the
    last X-Forwarded-For entry with `TRUST_PROXY=true`), so it can't be aimed at anyone else; 20
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
