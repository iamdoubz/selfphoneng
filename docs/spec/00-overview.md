# 00 — Overview

## 1. Goal

Build **SelfPhoneNG**: a fully open source, self-hosted
business phone system with the everyday features of 3CX:

- Extensions (users) with desk phones, softphones and a browser softphone
- A SIP trunk the customer brings (reference: voip.ms) carrying one or more DIDs (phone numbers)
- Inbound routing: DID → user / ring group / queue / IVR / voicemail, with business hours and holidays
- Outbound routing with permissions and toll-fraud protection
- Voicemail with email delivery and web playback
- IVR ("digital receptionist"), ring groups, call queues
- Call recording, call history (CDR), live call dashboard
- Transfer, hold, park, pickup, conference rooms, music on hold, paging/intercom
- Presence / BLF (busy lamp field)
- Desk phone auto-provisioning
- SMS through the trunk provider's API
- E911 handling that follows US multi-line telephone system law
- A REST API and webhooks
- Backups and one-command install with Docker Compose

Target user: one small business or home lab, 1–100 extensions, one server.

## 2. Non-goals for version 1

Do NOT build these in v1. Do not leave half-built hooks for them either.

- Multi-tenancy (several companies on one install)
- Native mobile apps (we document open source SIP apps instead, see `07-provisioning.md`)
- Video calls, screen sharing, team chat
- Fax
- CRM integrations (the REST API + webhooks are the integration point)
- Being a SIP carrier or selling numbers. The customer always brings their own trunk.
- High availability / clustering
- Our own SIP or RTP stack

## 3. Architecture

```
                    Internet
                       │
   ┌───────────────────┼─────────────────────────────────────────┐
   │ Host (Ubuntu/Debian, Docker)                                │
   │                   │                                         │
   │   ┌───────────────┴──────────┐   443/tcp (HTTPS + WSS)       │
   │   │ Reverse proxy            │◄──────── browsers, phones     │
   │   │ (bundled Caddy OR the    │          (provisioning)       │
   │   │  user's own nginx)       │                               │
   │   └───┬──────────────┬───────┘                               │
   │       │ /api /prov / │ /ws (SIP over WebSocket)              │
   │       ▼              ▼                                       │
   │  ┌──────────┐   ┌──────────────────────────┐ 5060/udp+tcp SIP│
   │  │ api      │AMI│ asterisk                 │◄─── voip.ms     │
   │  │ (Node)   ├──►│ (PJSIP, dialplan,        │◄─── desk phones │
   │  │ serves   │   │  voicemail, queues, ...) │ 10000-20000/udp │
   │  │ web UI   │   └──────────┬───────────────┘ RTP audio       │
   │  └──┬───┬───┘              │                                 │
   │     │   │ writes generated │ reads generated config,         │
   │     │   │ config files     │ writes voicemail/recordings     │
   │     │   ▼                  ▼                                 │
   │     │  ┌────────────────────────────────┐                    │
   │     │  │ shared volumes (./data/...)    │                    │
   │     │  └────────────────────────────────┘                    │
   │     ▼                                                        │
   │  ┌──────────┐                                                │
   │  │ postgres │                                                │
   │  └──────────┘                                                │
   └──────────────────────────────────────────────────────────────┘
```

### 3.1 Responsibilities

**Asterisk** (container `asterisk`): SIP registration of phones, SIP trunk
registration to voip.ms, call setup, audio, codecs, voicemail recording and
MWI, queues, conferences, music on hold, call recording to files, presence hints.
Asterisk holds **no business data of its own**. It reads config files that the
api generates. The only runtime state it keeps is in AstDB (§3.3).

**api** (container `api`, Node.js/TypeScript):
- Owns PostgreSQL. **PostgreSQL is the single source of truth.**
- Turns DB rows into Asterisk config files (the "generator", `03-config-generator.md`)
  and tells Asterisk to reload.
- Connects to the Asterisk Manager Interface (AMI) to receive events (calls,
  device states, registrations, CDRs) and send actions (originate, hangup, reload).
- Keeps an in-memory "live state" (active calls, extension states, trunk
  status) and pushes it to browsers over a WebSocket.
- Serves the REST API, the provisioning endpoints, and the built web UI (static files).
- Runs background jobs: voicemail email, retention cleanup, backups, nightly regeneration.

**web** (package `apps/web`, React): the admin panel, the user portal and the
browser softphone. It is built to static files and served by the api. It is
not a separate container.

**postgres**: application data.

**Reverse proxy**: TLS termination for HTTPS and WSS. Either the bundled Caddy
(automatic Let's Encrypt) or the user's existing nginx (sample config provided).

### 3.2 The config loop (memorize this)

```
Admin changes something in the UI
  → API validates (zod) and writes to PostgreSQL
  → API calls generator.apply() (debounced 1 s, one at a time)
      → generator reads the whole DB, renders all Asterisk files as strings
      → writes them atomically to /etc/asterisk/selfphoneng/
      → sends AMI reload commands for the modules whose files changed
  → Asterisk picks up the new config
```

Generation is **pure and complete**: the same DB contents always produce the
same files, byte for byte. We never patch a generated file in place. We
regenerate everything every time. That keeps it simple and testable.

### 3.3 Runtime toggles (AstDB)

Some settings change many times a day and must work even when the user
toggles them from a desk phone with a feature code (for example DND, call
forwarding, queue login). Regenerating config for each toggle would be
wasteful, so these live in **AstDB**, Asterisk's built-in key/value store,
and dialplan reads them with `${DB(...)}`.

Rules:
- PostgreSQL still stores the value (table `user_runtime_state`, see `02-data-model.md`).
- When the API changes a toggle, it writes PostgreSQL first, then AstDB via AMI `DBPut`/`DBDel`.
- When a feature code changes a toggle, the dialplan writes AstDB and fires
  `UserEvent(SpToggle,...)`. The API hears the event and writes PostgreSQL.
- On API startup (and after every AMI reconnect) the API pushes every toggle
  from PostgreSQL into AstDB (PostgreSQL wins).

AstDB keys (family/key). This list is complete; do not add keys without updating it.

| Key | Value | Meaning |
|---|---|---|
| `SP/DND/<ext>` | `1` or absent | Do Not Disturb |
| `SP/CFU/<ext>` | dial string digits or absent | Call forward unconditional (always) |
| `SP/CFB/<ext>` | digits or absent | Call forward on busy |
| `SP/CFNA/<ext>` | digits or absent | Call forward on no answer (instead of voicemail) |
| `SP/TCOVR/<timeConditionId>` | `open`, `closed`, or absent (absent = automatic) | Business hours manual override |
| `SP/BLOCK/<callerNumber>` | `1` | Inbound caller blocked |
| `SP/QPAUSE/<queueNum>/<ext>` | `1` or absent | Agent logged out (paused) in queue |

## 4. Tech stack (fixed — do not change without a decision record)

| Area | Choice | Version |
|---|---|---|
| Telephony engine | Asterisk, built from source, PJSIP channel driver only (no chan_sip) | 24 LTS (latest 24.x; see 01 §2 while only release candidates exist) |
| Language | TypeScript (strict mode) | 7.x (see decisions/0001) |
| Runtime | Node.js | 24 LTS |
| Package manager | pnpm workspaces | 9.x or newer |
| API framework | Fastify | 5.x |
| Validation | zod | 4.x |
| ORM / migrations | drizzle-orm + drizzle-kit | latest |
| Database | PostgreSQL | 18 |
| Password hashing | `@node-rs/argon2` (argon2id) | latest |
| Email | nodemailer | latest |
| Job scheduling | croner | latest |
| File watching | chokidar | latest |
| WebSocket (api) | @fastify/websocket | latest |
| Multipart uploads | @fastify/multipart | latest |
| Rate limiting | @fastify/rate-limit | latest |
| Cookies | @fastify/cookie | latest (decisions/0002) |
| PostgreSQL driver | pg | latest (decisions/0002) |
| QR codes | qrcode | latest |
| Logging | pino | latest |
| Tests | vitest | latest |
| Frontend | React 19 + Vite + TypeScript | latest |
| Routing (web) | react-router | 8.x |
| Data fetching (web) | @tanstack/react-query | 5.x |
| Styling | Tailwind CSS | 4.x |
| Forms (web) | react-hook-form + @hookform/resolvers | latest |
| Client state (web) | zustand | 5.x |
| Browser SIP | SIP.js | 0.21.x |
| Audio conversion | ffmpeg (in the api image) | distro version |
| Text-to-speech (optional, M12) | Piper | latest |
| Bundled reverse proxy | Caddy | 2.x |
| SIP test tools (dev only) | SIPp, baresip | distro versions |

The AMI client is written by us (`04-backend-api.md` §4). It's about 200 lines,
and existing npm AMI packages are unmaintained.

License for our code: **AGPL-3.0-or-later**. That fits a self-hosted network
service, and Asterisk is GPL-2.0. Put the license in `LICENSE` and a
`SPDX-License-Identifier: AGPL-3.0-or-later` header in every source file.

## 5. Repository layout

```
selfphoneng/                   (repo root; the folder on disk may be named differently)
├── AGENTS.md
├── CLAUDE.md                   (owner's file — do not overwrite)
├── LICENSE
├── README.md
├── package.json                (pnpm workspace root, scripts)
├── pnpm-workspace.yaml
├── docker-compose.yml
├── .env.example
├── docs/
│   ├── spec/                   (this spec)
│   ├── decisions/              (short decision records, NNNN-title.md)
│   └── admin-guide/            (end-user docs, written in M11)
├── asterisk/
│   ├── Dockerfile
│   ├── entrypoint.sh
│   └── conf/                   (STATIC Asterisk config, copied into the image)
│       ├── asterisk.conf
│       ├── modules.conf
│       ├── logger.conf
│       ├── manager.conf.template
│       ├── http.conf
│       ├── rtp.conf.template
│       ├── pjsip.conf          (just #includes the generated file)
│       ├── extensions.conf     (static helper contexts + #include generated)
│       ├── voicemail.conf      (#include generated)
│       ├── queues.conf         (#include generated)
│       ├── musiconhold.conf    (#include generated)
│       ├── confbridge.conf
│       ├── features.conf
│       ├── res_parking.conf
│       └── cdr_manager.conf
├── apps/
│   ├── api/
│   │   ├── Dockerfile
│   │   ├── drizzle.config.ts
│   │   ├── src/
│   │   │   ├── index.ts                (starts everything)
│   │   │   ├── config.ts               (reads + validates env vars with zod)
│   │   │   ├── db/
│   │   │   │   ├── schema.ts           (drizzle tables, matches 02-data-model.md)
│   │   │   │   ├── client.ts
│   │   │   │   └── migrations/         (generated by drizzle-kit)
│   │   │   ├── crypto/secrets.ts       (AES-256-GCM encrypt/decrypt)
│   │   │   ├── auth/                   (sessions, password hashing, API tokens, guards)
│   │   │   ├── ami/
│   │   │   │   ├── client.ts           (TCP AMI client)
│   │   │   │   └── events.ts           (typed event parsing)
│   │   │   ├── live/                   (in-memory live state + WebSocket hub)
│   │   │   ├── generator/
│   │   │   │   ├── index.ts            (render() and apply())
│   │   │   │   ├── sanitize.ts
│   │   │   │   ├── load.ts             (loads a full snapshot from DB)
│   │   │   │   ├── destinations.ts
│   │   │   │   ├── pjsip.ts
│   │   │   │   ├── dialplan/           (one file per feature)
│   │   │   │   ├── voicemail.ts
│   │   │   │   ├── queues.ts
│   │   │   │   ├── moh.ts
│   │   │   │   └── __golden__/         (golden test fixtures)
│   │   │   ├── routes/                 (Fastify route modules, one per resource)
│   │   │   ├── services/               (business logic used by routes + jobs)
│   │   │   ├── jobs/                   (scheduled background jobs)
│   │   │   ├── provisioning/
│   │   │   │   └── templates/          (phone config templates)
│   │   │   ├── integrations/voipms/    (voip.ms REST API client, SMS)
│   │   │   └── media/                  (ffmpeg audio conversion)
│   │   └── test/
│   └── web/
│       ├── index.html
│       ├── vite.config.ts
│       └── src/
│           ├── main.tsx
│           ├── api/                    (typed fetch client)
│           ├── components/
│           ├── pages/admin/
│           ├── pages/user/
│           ├── softphone/              (SIP.js wrapper + UI)
│           └── live/                   (WebSocket client)
├── packages/
│   └── shared/                         (zod schemas + TS types shared by api and web)
├── deploy/
│   ├── caddy/Caddyfile
│   └── nginx/selfphoneng.conf.example
├── scripts/                            (install.sh, backup.sh, restore.sh)
└── data/                               (gitignored; runtime volumes)
    ├── postgres/
    ├── asterisk-generated/             (→ /etc/asterisk/selfphoneng)
    ├── voicemail/                      (→ /var/spool/asterisk/voicemail)
    ├── recordings/                     (→ /var/spool/asterisk/monitor)
    ├── sounds-custom/                  (→ /var/lib/asterisk/sounds/custom)
    ├── moh/                            (→ /var/lib/asterisk/moh)
    ├── astdb/                          (→ /var/lib/asterisk/astdb.sqlite3 folder)
    ├── tls/
    └── backups/
```

Shared zod schemas live in `packages/shared` so the web UI and API validate the same way.

## 6. Glossary (read if any telephony word is unfamiliar)

| Term | Meaning |
|---|---|
| **PBX** | Private Branch Exchange. The phone system for a business. That is what we are building. |
| **SIP** | Session Initiation Protocol. The text protocol phones and servers use to set up calls (INVITE, REGISTER, BYE...). |
| **RTP** | Real-time Transport Protocol. Carries the actual audio, on UDP ports 10000–20000. |
| **SIP trunk** | A SIP account at a provider (voip.ms) that connects the PBX to the public phone network. |
| **DID** | Direct Inward Dialing number: a real phone number like 312-555-1234 that rings into the PBX. |
| **Extension** | An internal number (e.g. 101) belonging to a user. |
| **Endpoint** | In Asterisk PJSIP: one SIP identity (a phone account or a trunk). |
| **AOR** | Address of Record. Where Asterisk finds an endpoint's registered devices ("contacts"). |
| **Contact** | One registered device. One user can have several (desk phone + softphone). |
| **Registration** | A device telling the server "I am 101, reach me at this IP:port". The PBX also registers *to* voip.ms. |
| **Dialplan** | Asterisk's routing script (`extensions.conf`). Contexts contain extensions, which contain numbered priorities (steps). |
| **Context** | A named section of the dialplan, e.g. `[sp-internal]`. A channel is always "in" a context. |
| **Channel** | One leg of a call inside Asterisk (e.g. `PJSIP/101-00000003`). A normal call has two channels bridged together. |
| **Bridge** | Asterisk object that connects channels so they hear each other. |
| **Local channel** | A fake channel (`Local/101@ctx`) that runs dialplan as if it were a device. Used for ring groups and queues. |
| **AMI** | Asterisk Manager Interface. A TCP text protocol (port 5038) to receive events and send commands. |
| **AstDB** | Asterisk's built-in key/value database. |
| **CDR** | Call Detail Record. One row per call leg: who called whom, when, how long, outcome. |
| **linkedid** | Asterisk ID shared by all channels belonging to one logical call. Used to group CDRs. |
| **MWI** | Message Waiting Indicator. The voicemail light on a desk phone. |
| **BLF** | Busy Lamp Field. Phone buttons that light up when a colleague is on a call. Uses SIP SUBSCRIBE to Asterisk "hints". |
| **Hint** | Dialplan line telling Asterisk which device state an extension number shows (`exten => 101,hint,PJSIP/101`). |
| **IVR** | Interactive Voice Response: "Press 1 for sales...". 3CX calls this a "digital receptionist". |
| **Ring group** | One number that rings several users (all at once or one after another). |
| **Queue** | Callers wait in line with music until an agent is free (call-center style). |
| **Park** | Put a call in a numbered slot so anyone can pick it up by dialing the slot. |
| **Pickup** | Answer a phone that is ringing on someone else's desk. |
| **REFER** | SIP message used for transfers. |
| **Blind / attended transfer** | Blind: send the call on without talking first. Attended: talk to the target first, then join. |
| **DTMF** | The tones of keypad digits. We use RFC 4733 (in-band RTP events). |
| **Codec** | Audio encoding. We use G.722 (HD), µ-law (PCMU, US default) and A-law (PCMA). |
| **WebRTC** | Browser real-time media. The browser softphone uses SIP over WebSocket + WebRTC media (DTLS-SRTP, ICE). |
| **ICE / STUN / TURN** | NAT traversal for WebRTC. STUN discovers the public IP. TURN relays audio when nothing else works. |
| **NAT** | Network Address Translation (home/office routers). The #1 cause of one-way or missing audio. |
| **E911** | Enhanced 911: an emergency call that carries a registered street address. |
| **MLTS** | Multi-Line Telephone System. A PBX, legally. US Kari's Law and RAY BAUM'S Act apply. |
| **Feature code** | Star codes like `*97` (check voicemail). |
| **Provisioning** | A desk phone downloads its config file from the PBX over HTTP(S). |
| **E.164** | International number format (`+13125551234`). Inside the PBX we store North American numbers as 11 digits `13125551234`. |

## 7. Numbering plan (defaults; configurable in Settings)

All internal numbers share **one namespace**. A number may belong to only one
object (user, ring group, queue, IVR, conference, parking). The API must
reject duplicates across all object types (see `04-backend-api.md` §7.2).

As built (owner, 2026-10-21): internal numbers have **1 to 6 digits**, and any free one can be
given to any object (a first user on `1`). The ranges below only choose the **Next free**
suggestion, and are edited on Settings → Numbering. Generated patterns that take an internal
number match one digit or more (`_X!`, `_**X!`, `_*45X!`, `_*72X!`, `_*80X!`; golden case
`short-numbers`, which the Asterisk load test dials). One more clash is refused, both ways: a
one-digit number that a digital receptionist with direct dialing also uses as a menu key
(pressing it always picks the option).

| Range | Object |
|---|---|
| 100–499 | Users (extensions) |
| 500–549 | Ring groups |
| 550–599 | Queues |
| 600–649 | IVRs (dialable internally so admins can test them) |
| 700 | Park (transfer a call here to park it) |
| 701–720 | Parking slots |
| 800–849 | Conference rooms |
| 850–869 | Paging / intercom groups |
| `*` codes | Feature codes (`03-config-generator.md` §9) |

**Reserved and never assignable:** `211, 311, 411, 511, 611, 711, 811, 911, 933`
and anything starting with `0` or `1` followed by more than 2 digits. N11 codes
are real public services, so a user with extension 911 or 411 would break
emergency or directory calls.

## 8. External number format

- Store and compare North American numbers as **11 digits** starting with `1` (`13125551234`).
- Store international numbers as `011` + country code + number.
- The function `normalizeNumber(input, defaultCountry='1')` in `packages/shared/src/phone.ts` is the only place that does this:
  - strip spaces, dashes, dots, parentheses
  - `+1XXXXXXXXXX` → `1XXXXXXXXXX`
  - 10 digits starting with `[2-9]` → prefix `1`
  - `+<other>` → `011<other>`
  - otherwise return as-is if it contains only digits, `*` or `#`; else throw.
- Display: `1XXXXXXXXXX` → `(XXX) XXX-XXXX`.

## 9. Roles

| Role | Can do |
|---|---|
| `admin` | Everything |
| `user` | Their own extension: voicemail, call history, forwarding, DND, greetings, softphone, contacts, SMS on DIDs assigned to them |

(A third role, `manager`, with read-only reports and queue control, is a later addition. Don't build it in v1.)

## 10. Open questions for the owner

Project name: **SelfPhoneNG** (decided). In code and config it is written `selfphoneng`
(package scope `@selfphoneng/*`, paths, DB name). Short prefix `sp` (for SelfPhoneNG):
`sp-` for dialplan contexts, `SP_` for channel variables, `SP` for the AstDB family, `Sp…` for UserEvent names,
`sp_` for the session cookie, API token prefix and CDR variable mappings.

1. ~~Should v1 ship with the bundled Caddy enabled by default?~~ **Decided (2026-10-17):** Caddy stays an
   optional compose profile, and the nginx example is documented.
