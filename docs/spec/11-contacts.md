# 11 — Contacts

Owner, 2026-10-23: contacts come in two kinds, picked in the setup wizard and changeable later in
Settings → Contacts (`contacts.provider`):

- **Simple** (`builtin`): the `contacts` table (02), a phonebook inside SelfPhoneNG.
- **Robust** (`contrack`): [Contrack](https://github.com/arvarik/contrack), a self-hosted contact
  and relationship manager, running beside the PBX. SelfPhoneNG reads names from it and writes each
  call to the contact's timeline. The owner's own install uses this.

Both kinds feed the same features, so the rest of SelfPhoneNG asks one question, "who is
13125551234 for this user?", and doesn't care which one answers.

## 1. What contacts are used for (both kinds)

| Feature | Where | Today |
|---|---|---|
| My contacts: list, search, click to call, add/edit | `/me/contacts` (05 §4) | not built |
| Company phonebook, CSV and vCard (.vcf) import | `/admin/contacts` (05 §3) | not built |
| My contacts: CSV and vCard (.vcf) import | `/me/contacts` | not built |
| Caller name: softphone ringing, call history, voicemail list, call report email, transcripts | 05 §5, 04 §7.3, 10 §3 | extensions → caller ID name → number |
| "Add to contacts" from a call or voicemail | `/me/calls`, `/me/voicemail` | not built |
| Transfer search (contacts + extensions) | softphone (05 §5) | extensions only |
| Desk phone phonebook | provisioning (07) | extensions only |

Lookup order everywhere: **extensions → my contacts → company phonebook → caller ID name → number**.

## 2. The provider seam (`apps/api/src/contacts/`)

```ts
type ContactHit = {
  name: string;
  company: string | null;
  url: string | null; // Contrack: the contact's page
  book: 'mine' | 'company';
};

interface ContactsProvider {
  lookup(userId: string, number: string): Promise<ContactHit | null>; // normalized E.164-ish digits
  search(userId: string, q: string, limit: number): Promise<ContactDto[]>;
  list(userId: string, cursor?: string): Promise<ListResponse<ContactDto>>;
  create(userId: string, c: ContactInput): Promise<ContactDto>;
  update?(userId: string, id: string, c: ContactInput): Promise<ContactDto>; // builtin only
  remove?(userId: string, id: string): Promise<void>; // builtin only
  logCall?(userId: string, call: CallForLog): Promise<void>; // contrack only (§4.4)
}
```

- `builtin.ts` and `contrack.ts` implement it; `index.ts` picks one from `contacts.provider`.
- `lookup` is **never a network call in the call path**. Contrack answers from a per-user cache
  (§4.3); builtin answers from one indexed query.
- Numbers are compared after `normalizeNumber` (00 §8) on both sides, so "+1 (312) 555-1234",
  "312-555-1234" and "13125551234" match.
- Owner, 2026-10-23: **every address book belongs to one owner**, in both modes, and the company is
  one more owner. Simple: the builtin table, `owner_user_id` = the user, or null for the company.
  Contrack: every Contrack account is private, so the company gets **its own Contrack account**
  (the admin sets its token, §4.3) and each user connects **their own** account. SelfPhoneNG does
  the sharing:
  - the company book is shown read-only to everyone (lookup, search, desk phones);
  - a personal book is private; its owner can share contacts from it (§2.1).

### 2.1 Sharing contacts (owner, 2026-10-23)

Sharing **offers a copy**: the recipient **accepts or denies** each shared contact. Accepted, it is
imported into their own book, and from then on the two copies are separate (editing one doesn't
change the other). Denied, nothing is added. Nothing lands in anyone's book without their click.
Both modes.

- `/me/contacts`: select one or more contacts → **Share** → pick colleagues, or **Everyone in the
  company**. `POST /api/me/contacts/share { contactIds, userIds | everyone: true }` makes one
  pending offer per contact per recipient. The answer says how many offers went to how many people.
- The offer holds a **copy taken when it was shared** (name, company, email, numbers; not notes or
  a Contrack timeline), so the sender editing or deleting the contact later doesn't change it:

  ```sql
  create table contact_shares (
    id            uuid primary key default gen_random_uuid(),
    from_user_id  uuid references users(id) on delete set null,
    to_user_id    uuid not null references users(id) on delete cascade,
    contact       jsonb not null,   -- { name, company, email, numbers: [{ label, number }] }
    status        text not null default 'pending' check (status in ('pending', 'accepted', 'denied')),
    decided_at    timestamptz,
    created_at    timestamptz not null default now()
  );
  create index on contact_shares (to_user_id) where status = 'pending';
  ```

- The recipient sees **Shared with you** at the top of `/me/contacts` (a count on the Contacts
  link and a line on Home): "Dan Doe shared Acme Corp (312) 555-1234", with **Accept** and
  **Deny** on each, and **Accept all** / **Deny all** for one sender's batch.
  `GET /api/me/contacts/shares`, `POST /api/me/contacts/shares/accept|deny { ids }` (one id or
  a sender's batch).
- Accept imports with the duplicate rule (§3.1: same name and same normalized number already in
  the book → skipped, and the answer says so); the offer is `accepted` either way. Deny marks it
  `denied`. Decided offers are deleted after 30 days; pending ones stay until decided.
- The same contact offered again to someone with a pending offer of it replaces that offer, so a
  recipient never sees two of one contact.
- Contrack mode: the copy is read with the sender's token when sharing; Accept creates it with the
  recipient's token. A recipient without a connected Contrack account, or with a read-only token,
  can't accept yet: the offer says "Connect Contrack to accept" and waits.
- Only users, not the company book: an admin adds to the company book directly.

## 3. Simple (builtin)

The `contacts` table already in 02. `numbers[].number` is stored normalized (as forwards are,
04 §5.5) and shown with `formatNumber`. Lookup (`contacts/book.ts` `contactNames`) scans the two
books' numbers with `jsonb_array_elements`; a GIN index when books reach tens of thousands.

As built (C1): `GET /api/me/contacts` answers my whole book and the company's in one list (no
paging); the page searches it in the browser, and the browser looks up names from it (call
history, voicemail, Home, the ringing softphone). The call report email looks up on the server.

API (04 §7.3, §7.4, as already listed there):

| Route | Who | Does |
|---|---|---|
| `GET/POST/PATCH/DELETE /api/me/contacts[/:id]` | user | my contacts; `GET ?q=` searches name, company, number digits |
| `GET/POST/PATCH/DELETE /api/contacts[/:id]` | admin | company phonebook |
| `POST /api/contacts/import` | admin | CSV `name,company,email,label1,number1,...` (04 §7.4); preview, then commit |

UI: `/me/contacts` (mine + company read-only, search, click to call, add/edit drawer, import,
share), `/admin/contacts` (table, drawer, import), "Add to contacts" on calls and voicemail.

### 3.1 Import: CSV and vCard (owner, 2026-10-23)

Admins import into the company book, users into their own; same code, same screen.

- `POST /api/contacts/import` (admin) and `POST /api/me/contacts/import` (user): `{ files: [{ name,
  text }] }`, up to 20 files read as text in the browser (no multipart), `.csv` (04 §7.4 columns)
  or `.vcf` (any number of cards per file). 6 MB and 5,000 contacts per import. `?commit=0`
  answers a preview, `?commit=1` saves.
- vCard 2.1, 3.0 and 4.0, read by our own parser (`contacts/vcard.ts`, no new dependency): line
  unfolding, `QUOTED-PRINTABLE` and `CHARSET` (2.1), escaped `\,` `\;` `\n`, `item1.` groups.
  Fields: `FN` (or `N` when `FN` is empty), `ORG`, first `EMAIL`, every `TEL` with its `TYPE` as
  the label (cell → mobile, work, home, fax, other), `NOTE`. Everything else (photos, addresses,
  birthdays) is ignored.
- Preview: how many are new, how many are already in that book (same name and same normalized
  number: skipped), how many have no phone number (imported anyway: they still have a name and
  email), and the first rows that failed and why. Nothing is saved until **Import**.
- Contrack mode: SelfPhoneNG's import buttons open Contrack's own import (it reads Apple, Google,
  LinkedIn and vCard exports), for the company account too.

## 4. Robust (Contrack)

### 4.1 What Contrack is (checked 2026-10-23, v2.0.2 of 2026-10-18)

- TypeScript (Node ≥ 26.10), React, SQLite with sqlite-vec, **AGPL-3.0-only**. One Docker image,
  `ghcr.io/arvarik/contrack`, port 3210, data in `/app/data`.
- REST API under `/api` (OpenAPI 3.1 in its `docs/openapi.json`), plus MCP.
- Multi-user: every account has its own private address book. Credentials: the session cookie,
  or a **personal token** `Authorization: Bearer ctk_…` (read-only or read-write, made in
  Settings → Account). Tokens need sign-in on (`AUTH_REQUIRED=true`).
- Contacts carry `phones: [{ phone, label, isPrimary }]` (free text such as "+49 30 1234567").
- **Timeline**: `POST /api/contacts/:id/interactions` `{ type: 'call', title, content (HTML), date,
  duration (minutes), actionItem? }`; `PATCH /api/interactions/:id` changes `title`/`content`.
  A future `date` is refused.
- Its own AI (Gemini/OpenAI/Anthropic, or an OpenAI-compatible server such as our Ollama), web
  research (SearXNG), connectors (CardDAV, IMAP, calendar, Google), backups, CSV/vCard-style
  imports.

Endpoints SelfPhoneNG uses, and nothing else: `GET /healthz`, `GET /api/contacts?view=slim`,
`GET /api/contacts/:id`, `POST /api/contacts`, `GET /api/search?q=`,
`POST /api/contacts/:id/interactions`, `PATCH /api/interactions/:id`. A contract test checks them
against the pinned version's `openapi.json`.

### 4.2 Running it

- `deploy/contrack/compose.yml`, its own stack like `deploy/ai/compose.yml`: the image **pinned to
  a version tag** (not `latest`, decision 0001), `127.0.0.1:3210:3210`, a `contrack-data`
  volume, and `AUTH_REQUIRED=true`, `TRUST_PROXY_HOPS=1`, `PUBLIC_URL=https://${CONTRACK_HOSTNAME}`.
- People open Contrack on **its own host name** (`PUBLIC_URL` takes no path), e.g.
  `contacts.example.com`. The Caddyfile gets a second site block when `CONTRACK_HOSTNAME` is set;
  the nginx example gets a second server block. As built: both are commented blocks to uncomment
  (a Caddy site with an empty name would fail), and `docker compose --env-file .env -f
  deploy/contrack/compose.yml up -d` (a compose file in a subfolder reads no `.env` by itself).
- The PBX reaches it at `http://127.0.0.1:3210`. `contacts.contrack.url` must pass the same
  local-address check as the AI endpoints (10 §1), so contact data and tokens stay on the network.
- Backups: Contrack keeps its own snapshots in its volume. The SelfPhoneNG backup (pg_dump) does
  not include it; the admin guide says to back up the volume too.
- `docs/decisions/0003-contrack.md`: why an outside service (it already does relationships,
  timelines, imports, CardDAV sync, dedupe and search far beyond a phonebook), why it's allowed
  (AGPL, open source, a separate program over HTTP, so no license mixing and no code in our
  dependency tree), and the risk (one maintainer, young project: pinned version + contract test).

### 4.3 Connecting users

- Admin, Settings → Contacts (`contacts.provider`, `contacts.contrack` { url, publicUrl,
  companyTokenEnc }): **Test** (`POST /api/contacts/contrack/test`: `/healthz`, then the token
  against `/api/contacts?view=slim`; Contrack's `/api/auth/me` refuses tokens, so a token is
  checked by reading contacts).
- Admin, same page: the **company Contrack account's token** (read-only is enough; read-write lets
  "Add to company contacts" work), write-only like the SMTP password (`hasCompanyToken` in GET).
  The admin makes that account in Contrack (e.g. `company@…`) and fills it like any other.
- Contrack tokens expire in 90 days unless made with **Never**: the guide and the forms say to pick
  Never (or a year).
- Each user, My settings → Contacts: **paste a Contrack personal token** (read-write; read-only
  allowed, then nothing is written to the timeline). `PUT /api/me/contrack { token }` checks it
  reads contacts, then stores it with `encrypt()` in `users.contrack_token_enc` (contacts are a
  person's, not an extension's); `DELETE` disconnects. Never logged, never returned: `GET /api/me`
  has `contrack: { connected, tokenPrefix: "ctk_AbCdEfGh…", publicUrl }`.
  - Why not have the PBX create Contrack accounts: Contrack's admin routes refuse tokens
    (`SESSION_REQUIRED`), so the PBX would have to keep an admin password. A pasted token is
    explicit, revocable from Contrack, and scoped to one person.
- **Lookup cache** (`contacts/contrack.ts`): per connected user and for the company account,
  `GET /api/contacts?view=slim`, every phone through `normalizeNumber` (text that isn't a number
  is left out), held in memory. As built: fetched on use when older than 5 minutes (no timer),
  forgotten when SelfPhoneNG adds a contact or the token changes. A failing Contrack keeps the
  last good list and the error, and is tried again 5 minutes later; a refused token (401) shows as
  "doesn't work any more" in My settings. No error email.
- `/me/contacts` in this mode: search and list from Contrack (read-only rows, "Open in Contrack"
  link to `${publicUrl}/contact/:id`), plus the company book. "Add to contacts" does
  `POST /api/contacts { name, company, emails, phones: [{ phone, label }] }`. Editing, deleting
  and importing answer 409 in this mode: they happen in Contrack. Desk phone directories (07) get
  the company account's contacts. Accepting a share creates the copy with the recipient's token;
  without one it answers 409 and the offer waits.

### 4.4 Calls on the Contrack timeline

New per-user options (My settings → Contacts, shown when connected):

- **Log my calls in Contrack** (default on): each of my calls with a number that matches one of my
  Contrack contacts becomes a `call` interaction on that contact:
  - title: "Incoming call (answered)", "Missed call", "Outgoing call", "Voicemail left" …
  - date: `calls.started_at`; duration: talk minutes, rounded up; content: number, who answered,
    "recorded" (escaped HTML).
- **Add the call summary** (default off, needs `ai.callSummaries`): the summary and action items
  (10 §3) go in the content; the first action item also becomes a Contrack follow-up
  (`actionItem`). Warning next to it: if Contrack's own AI uses a cloud provider, what was said on
  the call reaches it. The admin guide recommends `AI_DISABLED=true` or our Ollama for Contrack.
- Job `contrackLog` (every 60 s, 04 §8): calls ended more than 1 min ago and not logged yet. A
  recorded call waits for its summary (`recordings.ai_done_at`) up to 30 minutes when the summary
  option is on. One row per logged call:

  ```sql
  create table contrack_call_log (
    call_id         uuid not null references calls(id) on delete cascade,
    user_id         uuid not null references users(id) on delete cascade,
    interaction_id  text,          -- null: no matching contact, or not logged
    logged_at       timestamptz not null default now(),
    primary key (call_id, user_id)
  );
  ```

  Contrack unreachable: try again next run, give up after 2 days (like call transcripts).
- Unknown numbers are not added to Contrack automatically; "Add to contacts" does it, and calls
  from then on are logged.

As built (C5, `contacts/timeline.ts`):

- Options on `users` (`contrack_log_calls`, `contrack_log_summaries`, `contrack_log_since`),
  `PATCH /api/me/contrack { logCalls?, logSummaries? }`, shown in `GET /api/me` `contrack` with
  `summariesAvailable`. Calls count from `contrack_log_since`: set when the token is first
  connected, and when logging is turned back on, so connecting doesn't fill the timeline with the
  last 2 days. Migration 0011 sets it to the migration time for people connected before.
- Calls between colleagues (`internal`) aren't logged. Every person on the call (caller, rang,
  answered) gets it on their own timeline, as in My calls, with their own contact.
- Titles: "Incoming call", "Incoming call, answered by Sue", "Missed call", "Missed call, voicemail
  left", "Outgoing call", "Outgoing call, busy" / "no answer". Content: `<p>From … to … · 3:12 ·
  recorded</p>`, then the summary's sentences and an `<ul>` of its action items, all escaped.
  `source: "selfphoneng"`. Contrack requires a due date on a follow-up: the day after the call,
  in the company time zone.
- `contrack_call_log` also has `error`: a refused write (4xx other than 401/429: a read-only
  token, a deleted contact, a bad request) is noted once and not retried. Contrack down (5xx,
  unreachable), or a token it refuses (401): tried again on the next run.
- Proven against Contrack 2.0.2 (`contrack-live.test.ts`): the entry, its follow-up, and the
  escaped content arrive. Contrack answers `duration` as a string ("4.0").

### 4.5 Not in Contrack mode

- Editing a Contrack contact from SelfPhoneNG.
- A contact in several books is shown once per book; lookup takes the first in §1's order.

## 5. Setup wizard and switching

- New step **Contacts**, after Users (05 §2.1): two cards.
  - **Simple**: "A phonebook inside SelfPhoneNG: names, numbers, CSV import. Nothing else to run."
  - **Contrack**: "A full contact and relationship manager next to the phone system: notes,
    reminders, relationship tracking, imports from Google/Apple/LinkedIn, CardDAV sync. Every call
    lands on the contact's timeline. Runs as its own container." Then the URL field, Test, and the
    two commands to start `deploy/contrack/compose.yml`. Skippable: "Set it up later" keeps Simple.
- Settings → Contacts can switch later. Builtin personal contacts are kept, not deleted; switching
  to Contrack offers **Copy my contacts to Contrack** per user (`POST /api/contacts/bulk`,
  ≤ 5,000), switching back just shows the builtin table again.

## 6. Order of work

| Task | What | Done when |
|---|---|---|
| C1 | Seam + Simple: migration, builtin provider, routes, `/me/contacts`, `/admin/contacts`, CSV and vCard import (§3.1), sharing (§2.1), "Add to contacts", lookup everywhere in §1 except desk phones | a contact's name shows in call history, voicemail, call report and the ringing softphone; an iPhone and a Google .vcf export import |
| C2 | Company book on desk phones (07) | a Yealink shows company contacts in its directory. Already built in M10-T2 (`loadPhonebook`, the builtin company book); C3 adds the Contrack company account to it |
| C3 | Contrack: decision 0003, `deploy/contrack`, Caddy/nginx blocks, Settings → Contacts, company token, per-user tokens, contrack provider + cache, sharing, setup wizard step | with the owner's Contrack, a call from a Contrack contact shows their name |
| C4 | Caller name on desk phones while ringing (owner, 2026-10-23: its own task after C3): the dialplan asks the api (AGI or `func_curl`) and sets `CALLERID(name)` | a desk phone rings with the contact's name, from either kind of book. Done, see §6.1 |
| C5 | Calls on the Contrack timeline (§4.4), summaries opt-in | an answered, recorded call shows up on the contact's Contrack timeline with its summary. Done, see §4.4 as built |
| C6 | Copy builtin contacts to Contrack; personal and shared contacts in desk phone directories | optional. Done, see §6.2 |

### 6.1 As built: C4

- `sp-sub-dial-user` (03 §6.2), for calls from outside only: `sp-sub-cnam` asks
  `GET /api/internal/caller-name?ext=&number=&token=` with `func_curl` (connect 1 s, answer 2 s).
  A name goes on each ringing leg with a pre-dial handler, `CONNECTEDLINE(name,i)` (what a
  PJSIP phone shows in the INVITE's From), not on the call: the next ring group member, a queue
  agent or a forward does its own lookup in its own user's book, and never sees another's.
- The prefix of a number, ring group or queue ("Sales:") is kept in front:
  `__SP_CNAM_PREFIX` grows the same way `CALLERID(name)` does.
- Globals `SP_CNAM_URL` (http://127.0.0.1:API_PORT/…) and `SP_CNAM_TOKEN` (HMAC-SHA256 of
  APP_SECRET, so it survives restarts). The route answers 404 unless the request comes from this
  machine without `X-Forwarded-For` (not through the reverse proxy) and with the key, and isn't
  logged (the key is in the query). Names come back as letters, digits, spaces and `. ' & @ -`,
  at most 40 characters, so nothing can be read as dialplan or SIP syntax.
- It never waits on Contrack: a stale book answers what it has and refreshes in the background,
  and the `contactsWarm` job refreshes every connected book every 5 minutes.
- `apps/api/test/asterisk/cnam-test.ts` proves it on real Asterisk with a baresip phone: a
  contact's name, a stranger's provider name, "Sales: Jane Doe" through a ring group, 101's
  contact name not reaching 102 after a no-answer forward, and the phone still ringing (with the
  provider's name) when the api hangs.

### 6.2 As built: C6

- A phone's directory (`/prov/phonebook/<mac>.xml`, 07) is the extensions, then **its owner's own
  contacts** (accepted shares are among them), then the company's, each by name, from the
  builtin books or Contrack. A phone whose extension has no user gets the extensions and the
  company only.
- Contrack mode: `GET /api/me/contacts` (and `/api/contacts`) says in `contrack.toCopy` how many
  builtin contacts that book's Contrack account doesn't have yet (same name and number), and the
  page offers **Copy them to Contrack**: `POST /api/me/contacts/copy-to-contrack` (admin:
  `/api/contacts/copy-to-contrack`, audited) sends them in one `POST /api/contacts/bulk` (with an
  `X-Import-Id`). The builtin rows stay, for switching back; once copied the offer is gone.
  Contrack's own duplicate check then runs on the import as usual.
- Proven against Contrack 2.0.2 (`contrack-live.test.ts`).

Tests: builtin lookup/search/import against the test DB; contrack provider against a fake HTTP
server built from the pinned `openapi.json`; one e2e script against a real Contrack container.

## 7. Decided

- Owner, 2026-10-23: caller name on desk phones while ringing is its own task, C4, after C3.
- Owner, 2026-10-23: in Contrack mode the company book is a company Contrack account shared with
  everyone; each user has their own private Contrack account.
- Owner, 2026-10-23: sharing offers a copy to picked colleagues or everyone, in both modes; each
  recipient accepts (it goes into their own book) or denies (nothing is added). An import or an
  accepted share skips contacts already in the book (§2.1, §3.1).
- Owner, 2026-10-23: admins and users can import .vcf files (§3.1).
