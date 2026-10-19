# 08 — Security, operations, legal

## 1. Threat model (what attacks a PBX on the internet)

| Threat | Example | Controls |
|---|---|---|
| SIP scanners / password guessing | "friendly-scanner", sipvicious hitting 5060 | Generated 24-char SIP passwords; no anonymous endpoint; fail2ban/CrowdSec on `security.log`; optional phone ACL (§2.2); firewall allow-list |
| **Toll fraud** (the expensive one) | Stolen SIP creds used to call premium international numbers | International route disabled by default; per-user outbound class; `max_channels`; voip.ms-side international block + balance limits (06 §1); forward targets checked against class |
| Web credential stuffing | Login brute force | argon2id, rate limits, audit log, TOTP for admins (M11) |
| Voicemail PIN guessing | Calling *98 and trying PINs | 6-digit default PIN, `maxlogins=3`, reject trivial PINs (`000000`, `123456`, the extension number repeated). As built (M11-T1): also for PINs changed from the phone's voicemail menu: `externpasscheck = /usr/local/bin/sp-vm-pincheck` (asterisk image, same rules, a unit test keeps it in step with `isTrivialPin`), `minpassword = 4`; the api stores accepted ones from AMI `VoicemailPasswordChange` (`services/vmpin.ts`), otherwise the next config write would put the old PIN back |
| Provisioning leaks | Fetching `/prov/<mac>.cfg` to steal SIP passwords | Per-device Basic auth, 404 on unknown MAC, rate limit + temporary IP block, optional LAN-only |
| Dialplan injection | Name `x); System(...)` | Sanitizers (03 §2), no `System()` anywhere |
| SSRF via webhooks | Webhook to `http://127.0.0.1:5038` | Private IP block by default (04 §9) |
| Stolen backup | Backup file copied | Backups exclude generated plaintext configs; DB secrets are encrypted with `APP_SECRET` (kept in `.env`, not in the backup); mode 0600 |
| AMI exposure | AMI reachable from network | Bound to 127.0.0.1, `permit` 127.0.0.1 only, random secret |

## 2. Required controls

### 2.1 Network
- Expose only 443/tcp, 5060/udp+tcp (5061/tcp if TLS), 10000–20000/udp.
- Admin guide includes an nftables example that limits 5060/5061 to voip.ms
  server IPs (from the voip.ms wiki list, **verify**) plus `sip.extraAllowedNets`, for setups with no remote phones.

### 2.2 Phone ACL (setting `sip.restrictPhonesToLocalNets`)
When true, the generator adds to every **desk** extension endpoint (not `-web`, not trunks):
```ini
deny = 0.0.0.0/0.0.0.0
permit = 192.168.0.0/16                ; each network.localNets + sip.extraAllowedNets (deduplicated)
```
Golden case `phone-acl`; `scripts/e2e/m11-t1.mjs` shows Asterisk refusing a REGISTER ("Not match
Endpoint ACL") and accepting it once the network is listed.

Changed from the first draft (M11-T1): `contact_acl = sp-phone-acl` names a section of **acl.conf**,
not pjsip.conf, and a `type = acl` section in pjsip.conf is res_pjsip_acl's *global* ACL, which would
filter trunks too. Contact-header rules alone are also weak: a phone behind NAT at home advertises a
private address. Source-address `deny`/`permit` on the endpoint is what keeps remote phones out.
Browser phones arrive through the reverse proxy (their source is the proxy), so `-web` endpoints
aren't filtered. The setting is on Settings → Security, with the provisioning switches (07 §2).

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
- Admin TOTP (M11): RFC 6238, 30 s, 6 digits, ±1 window, 10 single-use recovery codes (stored hashed).
- As built (M11-T1): the headers come from an `onSend` hook on every response (UI, API, `/prov`);
  `connect-src` also allows `WEBRTC_WS_URL`'s origin when it's set. The dark-mode bootstrap moved
  from an inline `<script>` in `index.html` to `/theme.js`, so `script-src` stays `'self'`.

### 2.5 Files and permissions
- `/etc/asterisk/selfphoneng/*` mode 0640, owner app UID.
- `.env` mode 0600 (install.sh sets it).
- Recordings and voicemail are served only through authenticated api routes, never as static files.

## 3. Operations

### 3.1 Install / update
- `scripts/install.sh` (01 §1.3).
- `scripts/update.sh`: `git pull --ff-only`, `docker compose build`, `docker compose up -d`. Migrations run automatically on api start. Print the new version.
- Version: `package.json` version at the root, exposed at `/api/system/status`. Semver. `CHANGELOG.md` kept by hand.
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
