# 14 — Spam check

Owner, 2026-10-27: when an outside caller isn't in anyone's contacts, look their number up and show
what's known about them. Why these providers and why it may leave the server:
[decision 0006](../decisions/0006-spam-check.md).

## 1. What it does

- An outside call rings a user, and the number is none of: an extension, a contact of that user, a
  company phonebook entry (the 11 §1 lookup finds no name). Then the api **checks the number**
  with a provider and the user sees the answer while it rings.
- **Information only** (owner): a check never blocks, reroutes or delays a call. The call rings at
  once; the answer appears when it arrives.
- **US numbers only** (owner: the callers are in the US): `1NXXNXXXXXX` after `normalizeNumber`
  (00 §8). Anything else, a withheld number, and internal calls are never checked.
- Shown in the **browser softphone** and **call history**; on **desk phones** only when the answer
  is in before their caller-name lookup gives up (§5.2).
- **Off by default** (owner). The admin turns it on in Settings → Spam check (§8).
- **Never in the way:** a provider that fails or is slow only means no answer is shown. Each
  failure is one `warn` log line with the provider and the reason (HTTP status, timeout, the
  provider's message), never the key or the request URL (IPQualityScore puts its key in the path).

## 2. Providers

The admin sets up either provider or both. The order is fixed (owner, 2026-10-27):
**IPQualityScore first** when it's set up; the **FTC list** answers when IPQualityScore isn't set
up or can't answer. v1 has these two:

| | IPQualityScore | FTC Do Not Call complaints |
|---|---|---|
| What | Fraud score and flags for any number, live | Unwanted-call complaints people filed with the FTC |
| Where it runs | An HTTPS request per check | A local copy, synced by a job; a check is a database query |
| Sends out | The caller's number | Nothing (it only downloads public data) |
| Key | IPQualityScore API key | api.data.gov key (free) |
| Cost | Free plan 1,000 lookups a month; paid from about $99 a month | Free |

"Can't answer" means: not set up, paused (§3), or this check failed. The FTC list is then asked
for that check only; nothing is remembered about the failure. Neither set up → no checks.

### 2.1 IPQualityScore (`spam/ipqs.ts`)

- `GET https://www.ipqualityscore.com/api/json/phone/{key}/{number}?country[]=US`, the number as
  11 digits, 4 s timeout.
- `success: false` whose message says the credits are used up ("You have insufficient credits to
  make this query…") → **exhausted**, §3. Any other `success: false`, an HTTP error or a timeout →
  a failure (logged, not cached, the FTC list asked).
- Risk (owner, 2026-10-27): **high** if `spammer` or `fraud_score >= 85`; **medium** if
  `fraud_score >= 75`, `recent_abuse` or `risky`; else **low**. These follow IPQualityScore's
  general advice (75 suspicious, 85 high risk).
- Kept (and nothing else from the answer): `fraud_score`, `spammer`, `recent_abuse`,
  `line_type`, `carrier`, `name`, `city`, `region`.
- Credit Usage API: `GET https://www.ipqualityscore.com/api/json/account/{key}` → `credits` (left
  in this billing period), `usage`, `phone_usage`. Used by Test, the Settings tab and §3.
  `// TODO(spec): confirm in SD2 that this call costs no credit.`

### 2.2 FTC Do Not Call complaints (`spam/ftc.ts`)

- Source: `GET https://api.ftc.gov/v0/dnc-complaints`, key in `X-Api-Key`,
  `created_date_from` / `created_date_to`, `sort_order=ASC`, `items_per_page=50` (the maximum),
  `offset`. Kept per complaint: `id`, `company-phone-number` (10 digits, stored with the leading
  1), `created-date`, `subject`, `recorded-message-or-robocall`.
- Not the daily CSV files on ftc.gov: the site answers scripted downloads with 403 (seen
  2026-10-27).
- **Sync job** `spamFtcSync`, every `syncHours` hours (default 24; the FTC posts weekday data by
  about noon Eastern, weekend data on Monday). It asks from the last synced `created-date` minus
  one day (complaint ids make the overlap harmless) up to now, then deletes complaints older than
  `windowDays` (default 30). The first sync fills the whole window. **Sync now** on the Settings
  tab starts one at once.
- Volume: 5,000 to 15,000 complaints a day (probed 2026-10-26), so 100–300 requests a day, and
  about 6,000 for the first 30 days. api.data.gov allows 1,000 requests an hour per key, so the
  sync paces itself to 900 an hour, saves where it got to, and the next run carries on (the first
  fill takes about 7 hours). A 429 ends the run there; the next run carries on.
- Risk from complaints in the window (owner, 2026-10-27): **high** at 3 or more, **medium** at
  1–2, **low** at none.
- Kept for the answer: the complaint count, how many were robocalls, the last complaint's date,
  the most common subject.
- The reports aren't verified, and spammers fake real people's numbers: the softphone and the
  admin guide say "reported to the FTC", never "is spam".

## 3. When IPQualityScore's credits run out

IPQualityScore counts credits per billing period, which needn't be a calendar month, and the free
plan may also have a daily cap. So rather than wait for the month to end, the api asks
IPQualityScore when credits are back:

1. A check answered "insufficient credits" → IPQualityScore is **paused** (`spam.state.ipqsPausedAt`):
   - one `system_events` row, `spam.quotaExhausted` (warning, source "Spam check");
   - one `warn` log line;
   - the dashboard warning `spam_quota` (04 §7, `GET /api/system/warnings`).
2. While paused, no request goes to IPQualityScore. Checks go to the FTC list if it's set up,
   else no checks are made. Nothing is logged per call.
3. Job `spamQuotaCheck`, every 6 hours while paused, asks the Credit Usage API. `credits > 0` →
   resumed: `ipqsPausedAt` cleared, a `spam.quotaRestored` info event, the warning goes away. If
   the account call fails, the job tries again next time.

The warning, shown once (owner): "IPQualityScore's lookups are used up. Spam checks use the FTC
list until they come back." (or "…are off until they come back." without the FTC list). It has a
**Dismiss** button (`POST /api/system/warnings/spam_quota/dismiss`, admin), which sets
`spam.state.warningDismissedAt`. Dismissed, it stays hidden until the next time the credits run out.

## 4. Cache (IPQualityScore only)

- `spam_lookups` (§7) keeps each answer, so a caller who rings again costs no credit:
  - **flagged** (medium or high) for `cache.flaggedDays`, default **14**;
  - **low** for `cache.cleanDays`, default **3**.
  - Both 1–365 days (owner: configurable).
- Failures aren't cached. Expired rows go in `retentionCleanup` (04 §8).
- One request per number at a time: a check already under way is shared (an in-memory map), so a
  ring group ringing five people costs one credit.
- The FTC needs no cache: its check is already a local query.

## 5. Where checks happen

Everything goes through `spam/check.ts` `checkNumber(number, { wait })` → `{ risk, provider,
info } | null`. It runs the §1 rules, then the cache, then the providers (§2). It doesn't do the
contacts test: each caller of it does that for its own user.

### 5.1 Browser softphone

- `GET /api/me/caller-check?number=` → `{ check: { risk, provider, info } | null }`. It answers
  `null` when the number is in this user's books (11 §1), isn't checked (§1), or no provider
  answered within 5 s.
- Only for a number that is ringing at one of the user's extensions, or rang there in the last
  2 minutes (live state, 04 §5.1); otherwise `null` without checking. A user can't spend
  credits on numbers that never called.
  `// TODO(spec): live state must keep the caller's number per ringing channel; check in SD4.`
- The softphone asks once per incoming call, as it starts ringing, and doesn't retry.
- Shown under the caller's name, in the ringing dialog and on the call card, for **high** and
  **medium** only; **low** shows nothing (owner, 2026-10-27):
  - a red "Likely spam" (high) or amber "Possible spam" (medium) badge;
  - a line with what's known: IPQualityScore "Fraud score 92 · spammer · VoIP · Verizon · Austin,
    TX" (and the name, if it has one); FTC "Reported to the FTC 4 times (3 robocalls), last on Oct
    20: Warranties & protection plans".
  - Not in the browser notification: that appears as the call starts, before the answer.

### 5.2 Desk phones

- In `GET /api/internal/caller-name` (11 §6.1): when there's no contact name, it waits for the
  check for up to 1.2 s (inside the dialplan's 2 s). A high or medium answer puts its label in
  front of the caller ID name: `deskPhoneLabels`, by default "SPAM LIKELY" and "Spam risk"
  (owner, 2026-10-27: configurable; no `?`, which `phoneSafeName` drops). The whole name goes
  through `phoneSafeName`, as now. A later answer is still cached for the softphone.
- The dialplan doesn't change, so no generator change and no new golden file.

## 6. Call history

- `calls.spam_risk` and `calls.spam_info` (§7) are written with the call row (CDR aggregation,
  incoming calls only) from `checkNumber(from_number, { cachedOnly: true })`: the cache and the
  local FTC copy, never a request out.
- The Calls pages (`/me/calls`, `/admin/calls`) show the §5.1 badge and line, unless the viewer's
  books name the number (contacts come first, 11 §1). The call list API adds
  `spam: { risk, provider, info } | null` to each item. The mobile app's call history (13 MB5)
  gets it from the same API.

## 7. Data and settings

Migration (SD1):

```sql
create table spam_lookups (            -- IPQualityScore answers (§4)
  number      text primary key,        -- 1NXXNXXXXXX
  provider    text not null,           -- 'ipqs'
  risk        text not null check (risk in ('low', 'medium', 'high')),
  info        jsonb not null,          -- the §2.1 fields only
  checked_at  timestamptz not null,
  expires_at  timestamptz not null
);
create index on spam_lookups (expires_at);

create table ftc_complaints (          -- the FTC copy (§2.2), kept windowDays
  id          text primary key,        -- the FTC's id
  number      text not null,           -- 1NXXNXXXXXX
  created_at  timestamptz not null,    -- the complaint's created-date
  subject     text,
  robocall    boolean
);
create index on ftc_complaints (number);
create index on ftc_complaints (created_at);

alter table calls add column spam_risk text, add column spam_info jsonb;
```

Settings (02 §3):

| Key | Type | Default | Notes |
|---|---|---|---|
| `spam` | object | below | the admin's choices |
| `spam.state` | object | `{}` | read-only to the API, like `system.*`: `ipqsPausedAt`, `warningDismissedAt`, `ftcSyncedTo`, `ftcCursor`, `ftcLastSyncAt`, `ftcLastError` |

```ts
spam = {
  enabled: false,
  ipqs: { keyEnc: string } | null,                       // null = not used; first when set (§2)
  ftc: { keyEnc: string, syncHours: 24, windowDays: 30 } | null,   // 1–168 hours, 7–365 days
  cache: { flaggedDays: 14, cleanDays: 3 },              // 1–365 each
  deskPhoneLabels: { high: 'SPAM LIKELY', medium: 'Spam risk' },  // 1–20 characters, §5.2
}
```

Keys are `_enc` (02, top: `crypto/secrets.ts`): the API returns `hasKey`, never the key; the audit
log masks it. Validated with zod (`packages/shared`).

### 7.1 Settings → Spam check

- **Spam check on** (the switch asks to confirm the first time, §8).
- **Use IPQualityScore**: key, **Test** (the Credit Usage API: shows the credits left without
  spending one), "paused until credits come back" while paused.
- **Use the FTC list**: api.data.gov key (a link to its sign-up), **Test** (one request),
  re-download every N hours, keep N days, last sync time and result, **Sync now**. With both on,
  the tab says IPQualityScore answers first and the FTC list when it can't.
- Keep answers: flagged N days, others N days.
- Desk phone labels: high, medium. Saving refuses a label `phoneSafeName` would change.
- Test buttons use the stricter Test rate limit, as the others do (04 §2.2).

## 8. Privacy

- Spam check is off until the admin turns it on. With IPQualityScore it is an exception to
  "nothing leaves the server": the caller's number (and nothing else: no name, no extension)
  goes to IPQualityScore. The FTC list sends nothing about calls.
- Turning on IPQualityScore asks once: "The numbers of outside
  callers who aren't in your contacts will be sent to IPQualityScore. You may need to say so in
  your privacy notice, and to have a data processing agreement with them. In the EU and UK the
  GDPR applies." The audit log records who turned it on.
- GDPR covers businesses in the EU or UK and calls from people there, so it isn't the owner's case
  (US callers only). The admin guide says so for everyone else, along with US state privacy laws
  such as California's. It's not legal advice.
- Admin guide: a new page `docs/admin-guide/spam-check.md` (what each provider is, what leaves the
  server, the FTC caveat, the free allowance) and a line in `legal.md`.

## 9. Order of work

| Task | What | Done when |
|---|---|---|
| SD1 | Decision 0006; this spec; the §7 migration and settings; `spam/check.ts` with both providers' lookups, the cache and the shared requests; Settings → Spam check with keys, Test, privacy confirmation | `pnpm lint && typecheck && test` pass; checks, cache times, the order (IPQualityScore, then the FTC list) and failures are tested against fake HTTP |
| SD2 | §3: pause, events, the `spam_quota` warning and Dismiss, `spamQuotaCheck` | an exhausted fake pauses, falls back to the FTC list, warns once and resumes; the owner's real key shows the credit call is free |
| SD3 | §2.2 sync: paging, pacing, the saved cursor, the window, Sync now | a fake FTC API with 3 days of data syncs, resumes after a 429 and drops old complaints; one real sync with the owner's key |
| SD4 | §5: `/api/me/caller-check`, the softphone badge and line, the desk phone labels | an unknown number rings the softphone and shows its answer; a contact or a low risk shows nothing; a desk phone shows "SPAM LIKELY" when the answer is in time |
| SD5 | §6 call history; the admin guide page | a checked call keeps its badge in call history after its cache expires |

Later, not now:
- **Report as spam** (owner, 2026-10-27: not now): a button in call history that reports the
  number to a provider that takes reports (OpenSpam has `POST /api/report`).
- **OpenSpam** as a provider for Spanish numbers (the owner has a key; it has little US data).
- **Low-risk details** (owner, 2026-10-27: nothing for now): show what IPQualityScore knows
  about a low-risk caller too (line type, carrier, city, name), without a badge.
