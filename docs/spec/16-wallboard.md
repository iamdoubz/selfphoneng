# 16 — Queue wallboard and agent break reasons

Owner, 2026-11-10: a big-screen page showing every queue live, and a reason an agent can give
when they stop taking queue calls, shown on the wallboard and added up in Reports.

## 1. What stays as it is

Pausing is still the queue login of 03 §6.8 and 04 §5.5: PostgreSQL `queue_member_state` is the
truth, AstDB `SP/QPAUSE/<queue>/<ext>` lets a phone toggle it with `*45<queue>`, and app_queue's
pause flag stops the calls. A break is a pause with a reason; coming back is the same unpause.
A pause without a reason works as before.

## 2. Break reasons

**The list**: setting `queues.breakReasons`, up to 9 strings, default empty (no reasons asked;
an update changes nothing). Each 1–30 characters: letters, digits, spaces and dashes, starting
and ending with a letter or digit, no two alike (case ignored). The charset is that narrow
because a reason goes into a dialplan global and into `PauseQueueMember`'s arguments
(`sanitize.breakReason`). Edited on Queues (one per line); the line number is the phone digit.

**Giving one**:
- Home (05 §4): with reasons set, a select "When I stop taking queue calls, it's for …" above
  the queue switches; its value goes with the next switch turned off.
  `POST /api/me/queues/:id/pause {reason?}`; a reason not in the list → 400.
- An admin pausing someone (`POST /api/queues/:id/members/:extId/pause {reason?}`) can send one
  too; the Queues page sends none.
- A phone: `*46<n><queue>` (`*462550`: reason 2, queue 550). The generator writes
  `SP_BREAK_<n>=<reason>` to the globals file; the dialplan pauses with that text, sets the
  AstDB key, and raises `SpToggle` with `Key: QPAUSE, Value: 1, Reason: <n>`. No reason with that
  number, or not an agent of the queue: `ss-noservice`. Coming back is `*45<queue>`, as today.

```
exten => _*46ZX!,1,Answer()                                 ; *46<n><queue> on a break, reason n
 same => n,Set(Q=${FILTER(0-9,${EXTEN:4})})
 same => n,Set(R=${GLOBAL(SP_BREAK_${EXTEN:3:1})})
 same => n,GotoIf($["${R}" = ""]?deny)                       ; no reason with that number
 same => n,PauseQueueMember(${Q},Local/${SP_EXT}@sp-queue-member/n,,${R})
 same => n,GotoIf($["${PQMSTATUS}" != "PAUSED"]?deny)        ; not an agent of that queue
 same => n,Set(DB(SP/QPAUSE/${Q}/${SP_EXT})=1)
 same => n,UserEvent(SpToggle,Key: QPAUSE,Queue: ${Q},Ext: ${SP_EXT},Value: 1,Reason: ${EXTEN:3:1})
 same => n,Playback(agent-loggedoff)
 same => n,Hangup()
 same => n(deny),Playback(ss-noservice)
 same => n,Hangup()
```

**Where the reason lives**:
- app_queue carries it: AMI `QueuePause` gets `Reason`, and `QueueMember` / `QueueMemberPause`
  events give `PausedReason` and `LastPause`. The live view (04 §5.1) reads those: a member gets
  `pausedReason?` and `pausedSince?` while paused.
- `queue_member_state.reason`: so the pause is sent again with its reason after a queue reload
  or a reconnect (03 §1 step 9).
- `queue_pauses`: every break, for the report.

```sql
alter table queue_member_state add column reason text;  -- null: none given, or not paused
create table queue_pauses (
  id            bigserial primary key,
  queue_id      uuid not null references queues(id) on delete cascade,
  extension_id  uuid not null references extensions(id) on delete cascade,
  reason        text,                    -- as it was named then; null: none given
  started_at    timestamptz not null default now(),
  ended_at      timestamptz              -- null: still on it
);
create index on queue_pauses (extension_id, started_at);
```
`services/queues.ts` `storePause` writes both for every pause and unpause, from the API and from
`SpToggle` alike. Pausing while paused (a new reason) ends the open break and starts another.
Renaming a reason in Settings leaves old breaks under the old name.

**Report**: `GET /api/reports/breaks?from&to` (admin, the range rules of the other reports):
one row per agent, queue and reason: `{ extension, name, queue, reason, breaks, seconds }`.
Breaks are cut at the range's edges; one still open counts up to now. Per queue, because someone
paused in two queues at once would otherwise count double. Reports shows it as **Agent breaks**
when there are any.

## 3. Wallboard

`/wallboard`, admins, its own page without the admin menu (for a screen on the wall); linked from
Queues. `pages/admin/WallboardPage.tsx`.

Per queue, a card:
- **Waiting**, **Longest wait** (ticking), **Agents free** (free / all). Waiting and Longest wait
  turn red once the longest wait passes the queue's `sla_seconds`.
- Today: calls, answered, hung up waiting, answered in time (`GET /api/queues/:id/stats`, every
  30 s).
- Agents: number, name, and Free / Ringing / On a call / Offline, or the break: its reason
  ("Not taking calls" when none) and how long.

A clock, a Full screen button (the browser's own), and a "Connecting…" line while the live socket
is down. Everything else comes from the live snapshot (04 §5.2), so nothing new on the server.

## 4. Tests

- `test/queues.test.ts`: the setting's rules; `/api/me` lists the reasons; the globals file;
  a pause from Home with a reason (AMI `Reason`, both tables), one not in the list (400);
  `SpToggle` with `Reason: 2`; unpause ends the break; the report; a user can't read it.
- `live/queues.test.ts`: `PausedReason` and `LastPause` in, kept across a status change, gone on
  unpause.
- Golden case `queue` has two reasons (`SP_BREAK_1`, `SP_BREAK_2`); every case has the `*46`
  code.

## 5. Open

- The Asterisk load test passes for the `queue` and `empty` cases (2026-11-10: the `*46` code
  loads without errors). Still to do: the rest of `pnpm test:asterisk`, and `*46` dialed from a
  real phone (owner).
- The wallboard on a real wall screen, with real calls.
- Later, if wanted: the wallboard for agents (today's numbers are an admin route); a signed link
  so a wall screen needs no admin sign-in; sound or colour thresholds per queue.
