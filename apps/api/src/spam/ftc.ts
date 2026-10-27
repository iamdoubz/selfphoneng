// SPDX-License-Identifier: AGPL-3.0-or-later
// The FTC's Do Not Call complaints (14 §2.2): a check reads the local copy, so it sends nothing
// out. The copy is synced by spamFtcSync (SD3).
import { sql } from 'drizzle-orm';
import type { FtcInfo, SpamRisk } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
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

/** Settings → Spam check → Test: one request with the api.data.gov key. */
export async function ftcTest(key: string): Promise<string> {
  try {
    await getJson(`${FTC_API}?items_per_page=1`, { 'X-Api-Key': key });
  } catch (err) {
    const m = (err as Error).message;
    if (m === 'HTTP 403') throw new SpamError('api.data.gov refused the key');
    if (m === 'HTTP 429') throw new SpamError('api.data.gov says the key is over its hourly limit');
    throw err;
  }
  return 'The FTC answered.';
}
