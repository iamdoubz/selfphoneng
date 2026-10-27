// SPDX-License-Identifier: AGPL-3.0-or-later
// The spam check (14 §5): the one way to ask what's known about a caller's number. Information
// only: nothing here changes a call, and a failure only means there's no answer (and one warning
// in the log). The contacts test (14 §1) is the caller's: it knows whose books to look in.
import { and, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  SpamStateSchema,
  type IpqsInfo,
  type SpamCheck,
  type SpamRisk,
  type SpamSettings,
  type SpamState,
} from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { settings, spamLookups } from '../db/schema.ts';
import { decrypt } from '../crypto/secrets.ts';
import { logEvent } from '../services/events.ts';
import { getSetting } from '../services/settings.ts';
import { ftcLookup } from './ftc.ts';
import { SpamError } from './http.ts';
import { ipqsCredits, ipqsLookup } from './ipqs.ts';

export type SpamDeps = { db: Db; log: Pick<FastifyBaseLogger, 'warn'> };

/** US numbers only (owner, 2026-10-27): 1NXXNXXXXXX after normalizeNumber (00 §8). */
export const isCheckable = (n: string) => /^1[2-9]\d{2}[2-9]\d{6}$/.test(n);

/** A check under way, by number: a ring group ringing five people costs one credit (14 §4). */
const pending = new Map<string, Promise<SpamCheck | null>>();

function warn(d: SpamDeps, provider: string, err: unknown) {
  if (err instanceof SpamError) d.log.warn({ provider, reason: err.message }, 'spam check failed');
  else d.log.warn({ provider, err }, 'spam check failed');
}

/**
 * IPQualityScore first when it's set up, then the FTC list (owner, 2026-10-27). `cachedOnly`:
 * the cache and the local FTC copy, never a request out (call history, 14 §6).
 */
export async function checkNumber(
  d: SpamDeps,
  number: string,
  opts: { cachedOnly?: boolean } = {},
): Promise<SpamCheck | null> {
  if (!isCheckable(number)) return null;
  const s = await getSetting(d.db, 'spam');
  if (!s.enabled) return null;
  if (s.ipqs) {
    const [hit] = await d.db
      .select()
      .from(spamLookups)
      .where(and(eq(spamLookups.number, number), gt(spamLookups.expiresAt, sql`now()`)));
    if (hit) return { risk: hit.risk as SpamRisk, provider: 'ipqs', info: hit.info as IpqsInfo };
    // Paused (14 §3): the cache still answers, IPQualityScore isn't asked.
    if (!opts.cachedOnly && !(await getSetting(d.db, 'spam.state')).ipqsPausedAt) {
      let p = pending.get(number);
      if (!p) {
        p = askIpqs(d, s, s.ipqs.keyEnc, number).finally(() => pending.delete(number));
        pending.set(number, p);
      }
      const answer = await p;
      if (answer) return answer;
    }
  }
  if (!s.ftc) return null;
  try {
    return { provider: 'ftc', ...(await ftcLookup(d.db, number, s.ftc.windowDays)) };
  } catch (err) {
    warn(d, 'ftc', err);
    return null;
  }
}

async function askIpqs(
  d: SpamDeps,
  s: SpamSettings,
  keyEnc: string,
  number: string,
): Promise<SpamCheck | null> {
  try {
    const a = await ipqsLookup(decrypt(keyEnc), number);
    if (a.kind === 'exhausted') {
      await pauseIpqs(d, s);
      return null;
    }
    const days = a.risk === 'low' ? s.cache.cleanDays : s.cache.flaggedDays;
    const expiresAt = sql`now() + make_interval(days => ${days})`;
    await d.db
      .insert(spamLookups)
      .values({ number, provider: 'ipqs', risk: a.risk, info: a.info, expiresAt })
      .onConflictDoUpdate({
        target: spamLookups.number,
        set: { risk: a.risk, info: a.info, expiresAt, updatedAt: new Date() },
      });
    return { risk: a.risk, provider: 'ipqs', info: a.info };
  } catch (err) {
    warn(d, 'ipqs', err);
    return null;
  }
}

/**
 * Merges `patch` into spam.state in one statement, so the jobs and checks don't overwrite each
 * other's fields. `onlyIf`: the condition the stored state must meet; false when it didn't.
 */
export async function patchSpamState(
  db: Db,
  patch: Partial<SpamState>,
  onlyIf?: SQL,
): Promise<boolean> {
  await db
    .insert(settings)
    .values({ key: 'spam.state', value: SpamStateSchema.parse({}) })
    .onConflictDoNothing();
  const rows = await db
    .update(settings)
    .set({
      value: sql`${settings.value} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(settings.key, 'spam.state'), onlyIf))
    .returning({ key: settings.key });
  return rows.length > 0;
}

const paused = sql`${settings.value}->>'ipqsPausedAt'`;

/** Out of credits (14 §3): paused, and the event, warning and log line once per time. */
async function pauseIpqs(d: SpamDeps, s: SpamSettings) {
  const first = await patchSpamState(
    d.db,
    { ipqsPausedAt: new Date().toISOString(), warningDismissedAt: null },
    isNull(paused),
  );
  if (!first) return;
  d.log.warn({ provider: 'ipqs' }, 'spam check: IPQualityScore credits are used up, paused');
  await logEvent(d.db, {
    severity: 'warning',
    code: 'spam.quotaExhausted',
    source: 'Spam check',
    message: `IPQualityScore's lookups are used up. ${s.ftc ? 'Spam checks use the FTC list' : 'Spam checks are off'} until they come back.`,
  });
}

/** Unpaused, by the job or a new key (14 §3). */
export async function resumeIpqs(db: Db, why: string) {
  const was = await patchSpamState(db, { ipqsPausedAt: null }, sql`${paused} is not null`);
  if (was)
    await logEvent(db, {
      severity: 'info',
      code: 'spam.quotaRestored',
      source: 'Spam check',
      message: `IPQualityScore lookups are back (${why}).`,
    });
}

/** Job spamQuotaCheck (14 §3), every 6 hours: while paused, are credits back? A failure throws
 *  (the job's log line) and the next run tries again. */
export async function spamQuotaCheck(db: Db) {
  const s = await getSetting(db, 'spam');
  if (!s.ipqs || !(await getSetting(db, 'spam.state')).ipqsPausedAt) return;
  const credits = await ipqsCredits(decrypt(s.ipqs.keyEnc));
  if (credits > 0) await resumeIpqs(db, `${credits} credits left`);
}
