// SPDX-License-Identifier: AGPL-3.0-or-later
// The call report email (05 §4): each user's calls of the last hour, day or week, with each
// recorded call's summary if they asked for it. No calls, no email.
import { and, asc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { formatNumber, type CallReport } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { callExtensions, calls, extensions, recordings, users } from '../db/schema.ts';
import type { SendMail } from './mail.ts';
import { getSetting } from './settings.ts';

/** Calls are written a few seconds after hang-up and summarized a minute or two after. */
const LAG_MS = 5 * 60_000;

/**
 * The last whole period that ended by `now`, in the time zone `tz`: e.g. daily at 08:00 is
 * yesterday 08:00 to today 08:00. Local-time arithmetic in PostgreSQL, so DST days are 23 or 25 h.
 */
export async function lastPeriod(
  db: Db,
  tz: string,
  s: { callReport: Exclude<CallReport, 'off'>; callReportTime: string; callReportWeekday: number },
  now: Date,
): Promise<{ from: Date; to: Date }> {
  const r = await db.execute<{ from: Date; to: Date }>(sql`
    with l as (select (${now.toISOString()}::timestamptz at time zone ${tz}::text) as t),
    s as (
      select t, case ${s.callReport}::text
          when 'hourly' then date_trunc('hour', t)
          when 'daily' then t::date + ${s.callReportTime}::time
          else t::date - ((extract(dow from t)::int - ${s.callReportWeekday}::int + 7) % 7)
            + ${s.callReportTime}::time
        end as at,
        case ${s.callReport}::text
          when 'hourly' then interval '1 hour'
          when 'daily' then interval '1 day'
          else interval '7 days'
        end as p
      from l),
    e as (select case when at > t then at - p else at end as at, p from s)
    select (at - p) at time zone ${tz}::text as "from", at at time zone ${tz}::text as "to" from e`);
  const row = r.rows[0]!;
  return { from: new Date(row.from), to: new Date(row.to) };
}

const duration = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
/** "102" stays as is; outside numbers get their usual format. */
const num = (n: string | null) => (n ? (n.length > 6 ? formatNumber(n) : n) : 'unknown');

export type ReportCall = {
  startedAt: Date;
  out: boolean;
  status: string;
  fromNumber: string | null;
  fromName: string | null;
  toNumber: string | null;
  talkSeconds: number;
  answeredBy: string | null;
  recorded: boolean;
  summary: string | null;
  summaryPending: boolean;
};

/** The email's text: one block per call, oldest first. */
export function reportText(
  tz: string,
  period: { from: Date; to: Date },
  list: ReportCall[],
  withSummaries: boolean,
): string {
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const lines = [
    `${list.length} call${list.length === 1 ? '' : 's'} from ${when.format(period.from)} to ${when.format(period.to)}:`,
  ];
  for (const c of list) {
    const who = c.out
      ? `Outgoing to ${num(c.toNumber)}`
      : `Incoming from ${num(c.fromNumber)}${c.fromName ? ` (${c.fromName})` : ''} to ${num(c.toNumber)}`;
    const facts = [
      c.status === 'answered' && c.answeredBy ? `answered by ${c.answeredBy}` : c.status,
      duration(c.talkSeconds),
      ...(c.recorded ? ['recorded'] : []),
    ];
    lines.push('', `${when.format(c.startedAt)}  ${who}`, `  ${facts.join(' · ')}`);
    if (withSummaries && c.summary)
      lines.push(
        ...c.summary
          .trim()
          .split('\n')
          .map((l) => `  ${l}`),
      );
    else if (withSummaries && c.summaryPending)
      lines.push('  Summary not ready yet: see Recordings in the web portal.');
  }
  return lines.join('\n') + '\n';
}

const answerer = alias(extensions, 'answerer');

/** One run: every user whose period ended and wasn't reported on yet. */
export async function sendCallReports(d: {
  db: Db;
  send: SendMail;
  log: { error(o: object, m: string): void };
  now: Date;
}): Promise<number> {
  const tz = await getSetting(d.db, 'general.timezone');
  const asOf = new Date(d.now.getTime() - LAG_MS);
  const due = await d.db
    .select({ e: extensions, email: users.email })
    .from(extensions)
    .innerJoin(users, eq(users.id, extensions.userId))
    .where(and(ne(extensions.callReport, 'off'), eq(users.isActive, true)));
  let sent = 0;
  for (const { e, email } of due) {
    if (e.callReport === 'off') continue;
    const period = await lastPeriod(d.db, tz, { ...e, callReport: e.callReport }, asOf);
    if (e.callReportSentAt && e.callReportSentAt >= period.to) continue;
    // ponytail: by hang-up time, and only the last period: one that passed while the server
    // was down isn't caught up.
    const rows = await d.db
      .select({
        c: calls,
        answeredBy: answerer.name,
        answeredById: answerer.id,
        summary: recordings.summary,
        aiDoneAt: recordings.aiDoneAt,
        out: sql<boolean>`exists (select 1 from ${callExtensions} where ${callExtensions.callId} = ${calls.id}
          and ${callExtensions.extensionId} = ${e.id} and ${callExtensions.role} = 'caller')`,
      })
      .from(calls)
      .leftJoin(answerer, eq(answerer.id, calls.answeredByExtensionId))
      .leftJoin(recordings, eq(recordings.id, calls.recordingId))
      .where(
        and(
          gte(calls.endedAt, period.from),
          lt(calls.endedAt, period.to),
          inArray(
            calls.id,
            d.db
              .select({ id: callExtensions.callId })
              .from(callExtensions)
              .where(eq(callExtensions.extensionId, e.id)),
          ),
        ),
      )
      .orderBy(asc(calls.startedAt));
    // Marked first: a failing mail server is logged once, not retried every minute.
    await d.db
      .update(extensions)
      .set({ callReportSentAt: period.to })
      .where(eq(extensions.id, e.id));
    if (!rows.length) continue;
    const list = rows.map((r): ReportCall => ({
      startedAt: r.c.startedAt,
      out: r.out,
      status: r.c.status,
      fromNumber: r.c.fromNumber,
      fromName: r.c.fromName,
      toNumber: r.c.toNumber,
      talkSeconds: r.c.talkSeconds,
      answeredBy: r.answeredById && r.answeredById !== e.id ? r.answeredBy : null,
      recorded: r.c.recordingId !== null,
      summary: r.summary,
      summaryPending: r.c.recordingId !== null && r.aiDoneAt === null,
    }));
    const withSummaries =
      e.callReportSummaries &&
      (await getSetting(d.db, 'ai.callTranscripts')) &&
      (await getSetting(d.db, 'ai.callSummaries'));
    try {
      await d.send({
        to: [email],
        subject: `Your calls (${e.number}): ${list.length} call${list.length === 1 ? '' : 's'}`,
        text: reportText(tz, period, list, withSummaries),
      });
      sent++;
    } catch (err) {
      d.log.error({ err, extension: e.number }, 'call report not sent');
    }
  }
  return sent;
}
