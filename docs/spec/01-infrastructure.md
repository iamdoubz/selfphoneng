# 01 — Infrastructure: Docker, Asterisk base, networking

## 1. Containers

| Service | Image | Network | Why |
|---|---|---|---|
| `postgres` | `postgres:18-alpine` | bridge, port published on `127.0.0.1:${POSTGRES_PORT:-5433}` | Port 5433 avoids clashing with a PostgreSQL the host may already run on 5432 |
| `asterisk` | built from `asterisk/Dockerfile` | **host** | SIP and 10,001 RTP ports. Docker port-publishing a 10k UDP range is slow and breaks NAT handling. Host networking is the standard fix. |
| `api` | built from `apps/api/Dockerfile` | **host** | Needs AMI on `127.0.0.1:5038` and serves on `127.0.0.1:${API_PORT:-8080}` |
| `caddy` (optional, compose profile `caddy`) | `caddy:2` | host | TLS on 80/443 for people without a reverse proxy |

### 1.1 `docker-compose.yml` (write exactly this, then adjust only if a test fails)

```yaml
name: selfphoneng

x-shared-volumes: &shared-volumes
  - ./data/asterisk-generated:/etc/asterisk/selfphoneng
  - ./data/voicemail:/var/spool/asterisk/voicemail
  - ./data/recordings:/var/spool/asterisk/monitor
  - ./data/sounds-custom:/var/lib/asterisk/sounds/custom
  - ./data/moh:/var/lib/asterisk/moh

services:
  postgres:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: selfphoneng
      POSTGRES_USER: selfphoneng
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set in .env}
    volumes:
      - ./data/postgres:/var/lib/postgresql   # PG 18 images keep data in /var/lib/postgresql/18/docker; mount the parent, NOT .../data
    ports:
      - "127.0.0.1:${POSTGRES_PORT:-5433}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U selfphoneng -d selfphoneng"]
      interval: 5s
      retries: 20

  asterisk:
    build:
      context: ./asterisk
      args:
        ASTERISK_UID: ${APP_UID:-1000}
        ASTERISK_GID: ${APP_GID:-1000}
    restart: unless-stopped
    network_mode: host
    environment:
      AMI_SECRET: ${AMI_SECRET:?set in .env}
      TZ: ${TZ:-America/Chicago}
    volumes:
      - ./data/asterisk-generated:/etc/asterisk/selfphoneng
      - ./data/voicemail:/var/spool/asterisk/voicemail
      - ./data/recordings:/var/spool/asterisk/monitor
      - ./data/sounds-custom:/var/lib/asterisk/sounds/custom
      - ./data/moh:/var/lib/asterisk/moh
      - ./data/astdb:/var/lib/asterisk/db
      - ./data/asterisk-logs:/var/log/asterisk

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    restart: unless-stopped
    network_mode: host
    user: "${APP_UID:-1000}:${APP_GID:-1000}"
    depends_on:
      postgres: { condition: service_healthy }
      asterisk: { condition: service_started }
    env_file: .env
    environment:
      DATABASE_URL: postgres://selfphoneng:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT:-5433}/selfphoneng
      AMI_HOST: 127.0.0.1
      AMI_PORT: "5038"
      AMI_USERNAME: selfphoneng
    volumes:
      - ./data/asterisk-generated:/etc/asterisk/selfphoneng
      - ./data/voicemail:/var/spool/asterisk/voicemail
      - ./data/recordings:/var/spool/asterisk/monitor
      - ./data/sounds-custom:/var/lib/asterisk/sounds/custom
      - ./data/moh:/var/lib/asterisk/moh
      - ./data/backups:/var/lib/selfphoneng/backups
      - ./data/tls:/var/lib/selfphoneng/tls

  caddy:
    image: caddy:2
    profiles: ["caddy"]
    restart: unless-stopped
    network_mode: host
    environment:
      PUBLIC_HOSTNAME: ${PUBLIC_HOSTNAME:?set in .env}
    volumes:
      - ./deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./data/caddy:/data
```

(The `x-shared-volumes` anchor documents the shared set. Services list volumes
explicitly so each one is easy to read.)

**File ownership:** Asterisk and the api both read and write the shared
folders. Both run as the same UID/GID (`APP_UID`/`APP_GID`, default 1000).
`scripts/install.sh` creates `./data/*` owned by that UID.

### 1.2 `.env.example`

```dotenv
# --- required ---
PUBLIC_HOSTNAME=pbx.example.com      # DNS name browsers and phones use
POSTGRES_PASSWORD=change-me          # install.sh generates a random one
AMI_SECRET=change-me                 # install.sh generates a random one
APP_SECRET=change-me                 # 32 random bytes, base64. Encrypts secrets in the DB. NEVER change after first run.
INITIAL_ADMIN_EMAIL=admin@example.com
INITIAL_ADMIN_PASSWORD=change-me     # only used if no admin exists yet

# --- optional ---
TZ=America/Chicago
API_PORT=8080
POSTGRES_PORT=5433
APP_UID=1000
APP_GID=1000
LOG_LEVEL=info
TRUST_PROXY=true                     # true when behind Caddy/nginx
RATE_LIMIT_PER_MINUTE=600            # requests per minute per client IP, every route; 0 = off
#NODE_EXTRA_CA_CERTS=/var/lib/selfphoneng/tls/idp-ca.pem  # a private CA for the OpenID provider or LDAPS (12 §1)
```

`apps/api/src/config.ts` validates these with zod at startup. If one is
missing or invalid, it logs a clear message and exits with code 1.

### 1.3 `scripts/install.sh`

1. Check `docker` and `docker compose` exist. Otherwise print how to install them and exit.
2. If `.env` is missing, copy `.env.example` and fill `POSTGRES_PASSWORD` and
   `AMI_SECRET` with `openssl rand -hex 32` (hex, because the Postgres password is embedded in
   `DATABASE_URL` and base64 can contain `/`), and `APP_SECRET` with `openssl rand -base64 32`. Prompt for
   `PUBLIC_HOSTNAME` and the admin email and password.
3. `mkdir -p` every `./data/*` folder and `chown` it to `APP_UID:APP_GID`.
4. Ask "Use bundled Caddy for HTTPS? [y/N]". If yes, run `docker compose --profile caddy up -d --build`. Otherwise run `docker compose up -d --build` and print the path of `deploy/nginx/selfphoneng.conf.example`.
5. Print the URL to open.

## 2. Asterisk image (`asterisk/Dockerfile`)

Build Asterisk **24 LTS from source**. Pin an exact version: the newest 24.x release on the day you write it, recorded here in
the same commit. **Pinned: `24.0.0-rc3` (2026-10-28).** The file in the repo is the source of truth; this copy is kept in sync.

> **Asterisk 24 status (checked 2026-10-17):** Asterisk 24 is the LTS line, but
> only release candidates are published so far (24.0.0-rc3 on 2026-10-28). Until 24.0.0 is final,
> develop against the newest 24.0.0-rcN. Release candidates may sit under a
> different download folder than `releases/`, so check the directory listing. Switch to 24.0.0 (or newer
> 24.x) as soon as it is final, and don't ship v1.0 on a release candidate. If a module, option
> or dialplan function in this spec turns out to have changed in 24, follow the Asterisk 24
> docs and update the spec (AGENTS rule 10).

**Changing the version** (owner, 2026-10-28). `apps/api/test/asterisk/verified.ts` lists what the
code relies on Asterisk doing (the "checked on 24.0.0-rcN" notes in these specs, and the TLS
qualify workaround in 08 §2.1), with the version it was measured on. `asterisk-version.test.ts`
(part of `pnpm test`) fails while the Dockerfile pins another version or this section names
another. To move: build the image, run `pnpm test:asterisk-upgrade` (boots it with the one-user
golden config next to a TLS provider with its own CA, measures each fact, and lists every one
that moved with what depends on it) and `pnpm test:asterisk`, change what moved, then set
`VERIFIED_ASTERISK` and update this section.

```dockerfile
# SPDX-License-Identifier: AGPL-3.0-or-later
FROM debian:trixie-slim AS build
ARG ASTERISK_VERSION=24.0.0-rc3
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl wget pkg-config autoconf automake libtool \
      libedit-dev libjansson-dev libxml2-dev uuid-dev libsqlite3-dev libssl-dev \
      libsrtp2-dev libcurl4-openssl-dev libspeexdsp-dev libogg-dev libvorbis-dev \
      libopus-dev subversion bzip2 patch python3 xmlstarlet
WORKDIR /usr/src
RUN curl -fsSLO https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VERSION}.tar.gz \
 && curl -fsSLO https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VERSION}.sha256 \
 && sha256sum -c asterisk-${ASTERISK_VERSION}.sha256 \
 && tar xzf asterisk-${ASTERISK_VERSION}.tar.gz
WORKDIR /usr/src/asterisk-${ASTERISK_VERSION}
# The mp3 decoder source (LGPL) must be fetched before configure so menuselect can enable format_mp3.
RUN contrib/scripts/get_mp3_source.sh || echo "mp3 source unavailable, format_mp3 skipped"
RUN ./configure --with-pjproject-bundled --with-jansson-bundled \
 && make menuselect.makeopts \
 && menuselect/menuselect \
      --disable BUILD_NATIVE \
      --enable format_mp3 \
      --enable CORE-SOUNDS-EN-WAV --enable CORE-SOUNDS-EN-G722 \
      --enable EXTRA-SOUNDS-EN-WAV --enable EXTRA-SOUNDS-EN-G722 \
      --enable MOH-OPSOUND-WAV \
      menuselect.makeopts \
 && make -j"$(nproc)" && make install DESTDIR=/out \
 && mkdir -p /out/usr/share/selfphoneng \
 && mv /out/var/lib/asterisk/moh /out/usr/share/selfphoneng/moh-opsound
# Debian's /var/run is a symlink to /run; a real directory here breaks the COPY below.
# Modules that run host commands go: AMI's ModuleLoad (class system) loads them past noload (08 §8).
RUN rm -rf /out/var/run \
 && for m in app_system func_shell app_disa res_agi app_externalivr; do rm /out/usr/lib/asterisk/modules/$m.so; done \
 && mkdir -p /out/etc/asterisk \
 && cp configs/samples/indications.conf.sample /out/etc/asterisk/indications.conf

FROM debian:trixie-slim
ARG ASTERISK_UID=1000
ARG ASTERISK_GID=1000
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libedit2 libjansson4 libxml2 libuuid1 libsqlite3-0 libssl3t64 libsrtp2-1 \
      libcurl4t64 libspeexdsp1 libogg0 libvorbis0a libvorbisenc2 libvorbisfile3 libopus0 \
      gettext-base ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g ${ASTERISK_GID} asterisk && useradd -u ${ASTERISK_UID} -g asterisk -d /var/lib/asterisk -s /usr/sbin/nologin asterisk
COPY --from=build /out/ /
COPY conf/ /etc/asterisk/
COPY entrypoint.sh /entrypoint.sh
COPY sp-vm-pincheck /usr/local/bin/sp-vm-pincheck
RUN chmod +x /entrypoint.sh /usr/local/bin/sp-vm-pincheck && mkdir -p /etc/asterisk/selfphoneng /var/lib/asterisk/db /var/lib/asterisk/moh /var/run/asterisk \
 && chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk
ENTRYPOINT ["/entrypoint.sh"]
```

Notes for the implementer:
- Debian package names change between releases. If an `apt-get install` fails
  on `trixie`, find the right name with `apt-cache search`. Do not switch base image.
- `format_mp3` downloads mp3 decoder source (LGPL) with `get_mp3_source.sh`, which must run before
  `configure`. That is allowed. If it fails, the build continues without it. Uploaded MP3s are converted by ffmpeg in the api anyway.
- **Do not** enable `codec_opus` or `codec_g729` from menuselect. Those are
  closed-source binary downloads. Browsers and phones get G.722 / µ-law instead.
- The `.sha256` file name pattern on downloads.asterisk.org may differ. Check
  the directory listing and use whatever checksum file is published.

### 2.1 `asterisk/entrypoint.sh`

```bash
#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
# 1. Render templates that need secrets from env.
envsubst '${AMI_SECRET}' < /etc/asterisk/manager.conf.template > /etc/asterisk/manager.conf
chown asterisk:asterisk /etc/asterisk/manager.conf
chmod 600 /etc/asterisk/manager.conf
# 2. Make sure every generated include file exists so Asterisk can boot
#    before the api has generated anything.
for f in pjsip_selfphoneng.conf extensions_selfphoneng.conf extensions_globals_selfphoneng.conf voicemail_selfphoneng.conf \
         queues_selfphoneng.conf musiconhold_selfphoneng.conf rtp_selfphoneng.conf \
         confbridge_selfphoneng.conf; do
  [ -f "/etc/asterisk/selfphoneng/$f" ] || : > "/etc/asterisk/selfphoneng/$f"
done
# 3. First start: seed the default music-on-hold class with the stock opsound files (CC-BY-SA).
if [ -z "$(ls -A /var/lib/asterisk/moh/default 2>/dev/null)" ]; then
  mkdir -p /var/lib/asterisk/moh/default
  cp /usr/share/selfphoneng/moh-opsound/*.wav /var/lib/asterisk/moh/default/
fi
# Bind-mounted volumes arrive owned by the host; Asterisk runs as the asterisk user.
for d in /etc/asterisk/selfphoneng /var/lib/asterisk/db /var/lib/asterisk/moh /var/log/asterisk \
         /var/spool/asterisk/voicemail /var/spool/asterisk/monitor /var/lib/asterisk/sounds/custom; do
  mkdir -p "$d" && chown -R asterisk:asterisk "$d"
done
# 4. Run in foreground as the asterisk user.
exec /usr/sbin/asterisk -f -U asterisk -G asterisk -vvv
```

## 3. Static Asterisk config files (`asterisk/conf/`)

These are written once by hand and copied into the image. Anything that
depends on DB data goes in a generated file under `/etc/asterisk/selfphoneng/`
that the static file `#include`s.

### 3.1 `asterisk.conf`
```ini
[directories](!)
astetcdir => /etc/asterisk
astmoddir => /usr/lib/asterisk/modules
astvarlibdir => /var/lib/asterisk
astdbdir => /var/lib/asterisk/db
astkeydir => /var/lib/asterisk
astdatadir => /var/lib/asterisk
astagidir => /var/lib/asterisk/agi-bin
astspooldir => /var/spool/asterisk
astrundir => /var/run/asterisk
astlogdir => /var/log/asterisk
astsbindir => /usr/sbin

[options]
verbose = 3
documentation_language = en_US
runuser = asterisk
rungroup = asterisk
defaultlanguage = en
```

### 3.2 `modules.conf`
```ini
[modules]
autoload = yes
; channel drivers we do not use
noload = chan_iax2.so
noload = chan_dahdi.so
noload = chan_mgcp.so
noload = chan_skinny.so
noload = chan_unistim.so
noload = chan_ooh323.so
noload = chan_motif.so
noload = res_xmpp.so
noload = res_pjsip_phoneprov.so   ; we do our own provisioning
noload = cdr_csv.so
noload = cdr_custom.so
noload = cdr_sqlite3_custom.so
noload = cel_sqlite3_custom.so
noload = cel_custom.so
noload = res_hep.so
noload = res_hep_pjsip.so
noload = res_hep_rtcp.so
noload = pbx_dundi.so
noload = pbx_lua.so
noload = pbx_ael.so
noload = res_config_ldap.so
noload = res_snmp.so
; unused features that only log errors about missing config files
noload = res_config_sqlite3.so
noload = res_statsd.so
noload = app_statsd.so
noload = res_pjsip_config_wizard.so
noload = res_pjsip_notify.so
noload = res_phoneprov.so
noload = res_pjsip_phoneprov_provider.so
noload = app_agent_pool.so
noload = res_calendar.so
noload = res_calendar_caldav.so
noload = res_calendar_ews.so
noload = res_calendar_exchange.so
noload = res_calendar_icalendar.so
noload = res_http_media_cache.so
noload = app_amd.so
noload = res_clialiases.so
noload = res_prometheus.so
noload = app_alarmreceiver.so
noload = app_festival.so
noload = app_followme.so
noload = app_minivm.so
noload = cel_manager.so
noload = res_stun_monitor.so
noload = chan_websocket.so
noload = res_adsi.so
noload = app_getcpeid.so
noload = app_adsiprog.so
```

Besides the files below, `asterisk/conf/` holds near-empty `cel.conf` (CEL off), `acl.conf`, `udptl.conf`,
`pjproject.conf`, `ari.conf` (ARI off), `websocket_client.conf` and `aeap.conf`. Without them core modules log
`ERROR` about missing files. The image also installs Asterisk's stock `indications.conf` (needed for `tone_zone = us`).

### 3.3 `logger.conf`
```ini
[general]
dateformat = %F %T.%3q
[logfiles]
console => notice,warning,error,verbose
messages.log => notice,warning,error
security.log => security        ; for fail2ban/CrowdSec
```

### 3.4 `manager.conf.template`
```ini
[general]
enabled = yes
port = 5038
bindaddr = 127.0.0.1
displayconnects = no
timestampevents = yes

[selfphoneng]
secret = ${AMI_SECRET}
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = system,call,agent,user,cdr,dialplan
write = system,call,command,originate,agent,user
writetimeout = 5000
```
Only the classes the api uses (owner, 2026-10-29; the list per action and event is in 08 §8).
The Asterisk tests mount this template with only `bindaddr` and `permit` opened up
(`test/asterisk/manager-conf.ts`), so a missing class fails them.

### 3.5 `http.conf` (WebSocket for the browser softphone)
```ini
[general]
enabled = yes
bindaddr = 127.0.0.1     ; only the reverse proxy talks to it
bindport = 8088
enablestatic = no
```
Asterisk serves SIP-over-WebSocket at `ws://127.0.0.1:8088/ws`. The reverse
proxy exposes it as `wss://PUBLIC_HOSTNAME/ws`. TLS is handled by the proxy,
not by Asterisk.

### 3.6 `rtp.conf`
```ini
[general]
rtpstart = 10000
rtpend = 20000
#include selfphoneng/rtp_selfphoneng.conf
```
(The generator writes `icesupport`, `stunaddr` and `[ice_host_candidates]` into
`rtp_selfphoneng.conf`, see `03-config-generator.md` §4. Since 2026-10-21 it also writes
`rtpstart`/`rtpend` there from the api's `RTP_PORT_START`/`RTP_PORT_END`: Asterisk takes a
setting's last value, so they win over the defaults above, which only cover the first boot.
`call-test.ts` checks `rtp show settings` with 31000–31200.)

### 3.7 `pjsip.conf`
```ini
; Everything is generated. Do not add sections here.
#include selfphoneng/pjsip_selfphoneng.conf
```

### 3.8 `extensions.conf`
```ini
[general]
static = yes
writeprotect = yes
clearglobalvars = yes

[globals]
#include selfphoneng/extensions_globals_selfphoneng.conf

; Static helper contexts (sp-sub-*) are generated too (03 §5) so that all
; dialplan lives in one place in code.
#include selfphoneng/extensions_selfphoneng.conf
```
### 3.9 `voicemail.conf`
```ini
#include selfphoneng/voicemail_selfphoneng.conf
```

### 3.10 `queues.conf`
```ini
[general]
persistentmembers = no        ; members come from config; pause state from AstDB/API
autofill = yes
monitor-type = MixMonitor
shared_lastcall = yes
log_membername_as_agent = yes
#include selfphoneng/queues_selfphoneng.conf
```

### 3.11 `musiconhold.conf`
```ini
[default]
mode = files
directory = /var/lib/asterisk/moh/default
sort = random
#include selfphoneng/musiconhold_selfphoneng.conf
```
The Asterisk image keeps the stock opsound MOH files (CC-BY-SA, open) in `/usr/share/selfphoneng/moh-opsound/`,
and `entrypoint.sh` copies them into `/var/lib/asterisk/moh/default/` (`./data/moh/default/`) when that folder is empty.
(Earlier drafts had `install.sh` do this; the entrypoint also covers installs that skip the script.)

### 3.12 `features.conf`
```ini
[general]
transferdigittimeout = 3
xfersound = beep
xferfailsound = beeperr
pickupexten = *8
featuredigittimeout = 1000

[featuremap]
blindxfer = ##
atxfer = *2
automixmon = *1       ; on-demand recording toggle (needs Dial option X)
```

### 3.13 `res_parking.conf`
```ini
[general]
parkeddynamic = no

[default]
parkext = 700
parkpos = 701-720
context = sp-parkedcalls
parkingtime = 120
comebacktoorigin = yes
comebackdialtime = 30
parkedmusicclass = default
findslot = next
parkext_exclusive = no
parkinghints = yes
```
`parkinghints` gives each slot a hint (`701@sp-parkedcalls` → `park:701@sp-parkedcalls`) for BLF
keys; phones reach it through `sp-local-numbers`, which includes `sp-parkedcalls`. An empty slot's
state is Unavailable (BLF off), a parked call makes it InUse. `findslot = next` means each park
takes the slot after the last one used, not always 701 (verified in M8-T2).

### 3.14 `confbridge.conf`
```ini
[general]
[default_bridge]
type = bridge
max_members = 20
mixing_interval = 20
internal_sample_rate = auto
record_conference = no

[default_user]
type = user
music_on_hold_when_empty = yes
announce_user_count = yes
announce_join_leave = no
dsp_drop_silence = yes

[default_menu]
type = menu
* = playback_and_continue(conf-usermenu)
1 = toggle_mute
#include selfphoneng/confbridge_selfphoneng.conf
```

### 3.15 `cdr.conf` and `cdr_manager.conf`
```ini
; cdr.conf
[general]
enable = yes
unanswered = yes
congestion = yes
endbeforehexten = yes
```
```ini
; cdr_manager.conf
[general]
enabled = yes
usegmtime = yes            ; times in UTC: the api parses them without guessing a time zone
[mappings]
linkedid => LinkedID       ; groups every leg of one call; not in the event by default
SP_DID => sp_did
SP_DIRECTION => sp_direction
SP_REC => sp_recording
```
The api turns `Cdr` AMI events into rows in `cdr` (see `04-backend-api.md` §5.4).
Without the `linkedid` mapping, Asterisk 24's `Cdr` event has `UniqueID` but no `LinkedID`, and
its times have no zone (checked on 24.0.0-rc2, M7-T1).

## 4. Networking and NAT

### 4.1 Ports

| Port | Proto | Who connects | Expose to internet? |
|---|---|---|---|
| 443 | TCP | Browsers (UI + WSS softphone), phones (provisioning) | Yes |
| 80 | TCP | Let's Encrypt HTTP challenge (Caddy only) | Only with Caddy |
| 5060 | UDP+TCP | voip.ms, remote desk phones / softphones | Yes, ideally limited to voip.ms IPs + known remote IPs |
| 5061 | TCP | TLS SIP (optional, remote phones, voip.ms encrypted) | Optional |
| 10000–20000 | UDP | RTP audio from voip.ms, phones, browsers | Yes |
| 5038 | TCP | AMI | **Never** (bound to 127.0.0.1) |
| 8088 | TCP | Asterisk HTTP/WS | **Never** (bound to 127.0.0.1) |
| 8080 | TCP | api | **Never** (bound to 127.0.0.1, behind proxy) |
| 5433 | TCP | PostgreSQL | **Never** (bound to 127.0.0.1) |

### 4.2 NAT rules (most audio problems come from here)

The settings page "Network" (stored in `settings`, generated into PJSIP transports) has:
- `publicIp`: the WAN IP. The UI has a "Detect" button (the api asks `https://api.ipify.org`, and the user can override it).
- `localNets`: list of CIDRs that are "inside" (default `192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12`).

The admin guide (M11) must tell the user to:
1. **Turn off SIP ALG** on every router between the server and the internet. It rewrites SIP packets and breaks calls.
2. Port-forward UDP 5060 and UDP 10000–20000 to the server. With double NAT (ISP
   router in front of their own router), do it on both routers, or use DMZ on the outer one.
3. Set `publicIp`. With a dynamic IP, also enable the "Re-check public IP every
   5 minutes" option (job `publicIpWatch`). When the IP changes, the job updates
   settings and triggers a regenerate + Asterisk restart (§4.3).

### 4.3 Changes that need an Asterisk restart

PJSIP transports cannot be safely reloaded. If the generator sees that the
transport sections changed, it writes the files, does NOT reload, and sets
`settings.restartRequired = true`. The UI then shows a banner: "Network
settings changed. Restart telephony to apply (active calls will drop)." with
a button. The button calls `POST /api/system/asterisk/restart`, which sends
AMI `Command: core restart gracefully` (waits for calls to end) or, with
`?now=true`, `core restart now`.

## 5. Reverse proxy

### 5.1 `deploy/caddy/Caddyfile`
```
{$PUBLIC_HOSTNAME} {
	encode zstd gzip
	@sipws path /ws
	handle @sipws {
		reverse_proxy 127.0.0.1:8088
	}
	handle {
		reverse_proxy 127.0.0.1:8080
	}
}
```

### 5.2 `deploy/nginx/selfphoneng.conf.example`
```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    http2 on;
    server_name pbx.example.com;

    ssl_certificate     /etc/letsencrypt/live/pbx.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pbx.example.com/privkey.pem;

    client_max_body_size 50m;     # audio uploads

    # SIP over WebSocket -> Asterisk
    location = /ws {
        proxy_pass http://127.0.0.1:8088/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Everything else (UI, API, live WebSocket /api/live, provisioning) -> api
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}
```
Add a comment block to the example: if 443 is handled by an nginx `stream {}`
block that forwards with `proxy_protocol`, this server must instead
`listen 127.0.0.1:<port> ssl proxy_protocol;` and set
`set_real_ip_from 127.0.0.1; real_ip_header proxy_protocol;`, or the api
will see every client as 127.0.0.1, which breaks login rate limiting and audit logs.

## 6. api image (`apps/api/Dockerfile`)

```dockerfile
# SPDX-License-Identifier: AGPL-3.0-or-later
FROM node:24-trixie-slim AS build
RUN npm install -g corepack@latest && corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @selfphoneng/shared build \
 && pnpm --filter @selfphoneng/web build \
 && pnpm --filter @selfphoneng/api build \
 && pnpm --filter @selfphoneng/api deploy --legacy --prod /out

FROM node:24-trixie-slim
# pg_dump must be the same major version as the server (18). Debian's own
# postgresql-client is older, so use the official PostgreSQL apt repo (PGDG).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-18 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/apps/web/dist ./public
COPY --from=build /src/apps/api/src/db/migrations ./dist/db/migrations
ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","dist/index.js"]
```
`pnpm deploy --legacy` copies the api with real (non-symlinked) production `node_modules`; `@selfphoneng/shared` ships its built `dist/` (`"files": ["dist"]`). Debian trixie matches the Asterisk image.

On start, `index.ts` does, in order: validate env → connect DB → run
migrations → create the initial admin if none exists → start Fastify → connect AMI →
sync AstDB → `generator.apply({ force: true })` → start jobs.
