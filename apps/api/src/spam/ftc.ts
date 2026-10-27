// SPDX-License-Identifier: AGPL-3.0-or-later
// The FTC's Do Not Call complaints (14 §2.2): a check reads the local copy, so it sends nothing
// out. spamFtcSync keeps the copy.
import { lt, sql } from 'drizzle-orm';
import type { FtcInfo, SpamRisk } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { ftcComplaints } from '../db/schema.ts';
import { decrypt } from '../crypto/secrets.ts';
import { getSetting } from '../services/settings.ts';
import { todayIn } from '../generator/load.ts';
import { isCheckable, patchSpamState } from './check.ts';
import { SpamError, getJson } from './http.ts';

export const FTC_API = 'https://api.ftc.gov/v0/dnc-complaints';

/** Risk (owner, 2026-10-27): 3 or more complaints in the window high, 1–2 medium. */
export const ftcRisk = (complaints: number): SpamRisk =>
  complaints >= 3 ? 'high' : complaints >= 1 ? 'medium' : 'low';

/** The complaints about `number` (1NXXNXXXXXX) in the last `windowDays`. */
export async function ftcLookup(
  db: Db,
  number: string,
  windowDays: number,
): Promise<{ risk: SpamRisk; info: FtcInfo }> {
  const r = await db.execute<{
    complaints: number;
    robocalls: number;
    last: Date | string | null;
    subject: string | null;
  }>(sql`
    select count(*)::int as complaints,
           (count(*) filter (where robocall))::int as robocalls,
           max(reported_at) as last,
           mode() within group (order by subject) as subject
      from ftc_complaints
     where number = ${number}
       and reported_at > now() - make_interval(days => ${windowDays})`);
  const row = r.rows[0]!;
  const info: FtcInfo = {
    complaints: row.complaints,
    robocalls: row.robocalls,
    lastReportedAt: row.last === null ? null : new Date(row.last).toISOString(),
    subject: row.subject,
  };
  return { risk: ftcRisk(info.complaints), info };
}

const OVER_LIMIT = 'api.data.gov says the key is over its hourly limit';

async function ftcGet(key: string, q: Record<string, string>) {
  try {
    return await getJson(`${FTC_API}?${new URLSearchParams(q)}`, { 'X-Api-Key': key });
  } catch (err) {
    const m = (err as Error).message;
    if (m === 'HTTP 403') throw new SpamError('api.data.gov refused the key');
    if (m === 'HTTP 429') throw new SpamError(OVER_LIMIT);
    throw err;
  }
}

/** Settings → Spam check → Test: one request with the api.data.gov key. */
export async function ftcTest(key: string): Promise<string> {
  await ftcGet(key, { items_per_page: '1' });
  return 'The FTC answered.';
}

// ponytail: the FTC's dates have no zone; taken as Eastern (it's in Washington). Hours off at
// worst, against a window of weeks.
const FTC_TZ = 'America/New_York';
const PAGE = 50;
const DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const nextDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const daysBefore = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** One complaint as stored, or null for one without a usable US number or date. */
function complaint(c: unknown) {
  const { id, attributes: a } = (c ?? {}) as { id?: unknown; attributes?: Record<string, unknown> };
  const phone = `1${String(a?.['company-phone-number'] ?? '')}`;
  const at = a?.['created-date'];
  if (
    typeof id !== 'string' ||
    !isCheckable(phone) ||
    typeof at !== 'string' ||
    !DATE_TIME.test(at)
  )
    return null;
  const robo = a?.['recorded-message-or-robocall'];
  return {
    id,
    number: phone,
    reportedAt: sql`${at}::timestamp at time zone ${FTC_TZ}`,
    subject: typeof a?.subject === 'string' && a.subject ? a.subject : null,
    robocall: robo === 'Y' ? true : robo === 'N' ? false : null,
  };
}

/**
 * Job spamFtcSync (14 §2.2), every minute: when a sync is due or under way, read up to `budget`
 * pages (15 a minute is 900 an hour, under api.data.gov's 1,000) a day at a time, oldest first,
 * saving where it got to. A failure (a 429 among them) is saved for the Settings tab and the next
 * minute carries on from the same page. Returns the error, for the job's log line once.
 */
export async function ftcSync(
  db: Db,
  opts: { now?: Date; budget?: number } = {},
): Promise<string | null> {
  const now = opts.now ?? new Date();
  const s = await getSetting(db, 'spam');
  if (!s.enabled || !s.ftc) return null;
  const st = await getSetting(db, 'spam.state');
  let cursor = st.ftcCursor;
  if (!cursor) {
    const due =
      !st.ftcLastSyncAt ||
      now.getTime() - Date.parse(st.ftcLastSyncAt) >= s.ftc.syncHours * 3_600_000;
    if (!due) return null;
    // From the newest complaint kept, less a day for ones posted late; at most the window.
    const r = await db.execute<{ day: string | null }>(
      sql`select to_char(max(reported_at) at time zone ${FTC_TZ}, 'YYYY-MM-DD') as day from ftc_complaints`,
    );
    const first = daysBefore(todayIn(FTC_TZ, now), s.ftc.windowDays);
    const last = r.rows[0]?.day ? daysBefore(r.rows[0].day, 1) : first;
    cursor = { day: last > first ? last : first, offset: 0 };
  }
  const key = decrypt(s.ftc.keyEnc);
  const today = todayIn(FTC_TZ, now);
  for (let n = 0; n < (opts.budget ?? 15); n++) {
    let page: unknown[];
    try {
      const j = await ftcGet(key, {
        created_date_from: `"${cursor.day} 00:00:00"`,
        created_date_to: `"${cursor.day} 23:59:59"`,
        sort_order: 'ASC',
        items_per_page: String(PAGE),
        offset: String(cursor.offset),
      });
      if (!Array.isArray(j.data)) throw new SpamError('the answer had no complaints list');
      page = j.data;
    } catch (err) {
      const error = err instanceof SpamError ? err.message : 'the sync failed';
      await patchSpamState(db, { ftcCursor: cursor, ftcLastError: error });
      if (!(err instanceof SpamError)) throw err;
      return error === st.ftcLastError ? null : error;
    }
    const rows = page.map(complaint).filter((c) => c !== null);
    if (rows.length) await db.insert(ftcComplaints).values(rows).onConflictDoNothing();
    if (page.length === PAGE) cursor = { day: cursor.day, offset: cursor.offset + PAGE };
    else if (cursor.day < today) cursor = { day: nextDay(cursor.day), offset: 0 };
    else {
      await db
        .delete(ftcComplaints)
        .where(
          lt(
            ftcComplaints.reportedAt,
            sql`${now.toISOString()}::timestamptz - make_interval(days => ${s.ftc.windowDays})`,
          ),
        );
      await patchSpamState(db, {
        ftcCursor: null,
        ftcLastSyncAt: now.toISOString(),
        ftcLastError: null,
      });
      return null;
    }
  }
  await patchSpamState(db, { ftcCursor: cursor, ftcLastError: null });
  return null;
}
