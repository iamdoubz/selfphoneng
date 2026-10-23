// SPDX-License-Identifier: AGPL-3.0-or-later
// Calls on the Contrack timeline (11 §4.4): each call of a connected person with one of their
// Contrack contacts becomes a "call" interaction on that contact, with the recorded call's
// summary if they asked for it. Unknown numbers are not added to Contrack.
import { and, asc, eq, gt, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { formatNumber } from '@selfphoneng/shared';
import { decrypt } from '../crypto/secrets.ts';
import type { Db } from '../db/client.ts';
import {
  callExtensions,
  calls,
  contrackCallLog,
  extensions,
  recordings,
  users,
} from '../db/schema.ts';
import { todayIn } from '../generator/load.ts';
import { getSetting } from '../services/settings.ts';
import { ContrackError, contrackBook, contrackInteraction, contrackSettings } from './contrack.ts';

/** A recorded call waits this long for its summary before it's logged without one. */
const SUMMARY_WAIT_MS = 30 * 60_000;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n: string | null) => (n ? (n.length > 6 ? formatNumber(n) : n) : 'an unknown number');
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export type TimelineCall = {
  out: boolean;
  status: string;
  fromNumber: string | null;
  toNumber: string | null;
  talkSeconds: number;
  /** Someone else answered (a ring group or queue colleague). */
  answeredBy: string | null;
  recorded: boolean;
};

/** "Action items:" lines of a summary (10 §3), and the text before them. */
export function splitSummary(summary: string): { text: string[]; items: string[] } {
  const lines = summary
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const at = lines.findIndex((l) => /^action items:/i.test(l));
  if (at < 0) return { text: lines, items: [] };
  return {
    text: lines.slice(0, at),
    items: lines
      .slice(at + 1)
      .filter((l) => /^[-*•]\s+/.test(l))
      .map((l) => l.replace(/^[-*•]\s+/, ''))
      .filter((l) => !/^none\.?$/i.test(l)),
  };
}

/** The interaction for one call: title, HTML content, minutes, the first action item. */
export function timelineEntry(c: TimelineCall, summary: string | null) {
  const missed = ['missed', 'voicemail', 'abandoned'].includes(c.status);
  const title = c.out
    ? c.status === 'answered'
      ? 'Outgoing call'
      : `Outgoing call, ${c.status === 'busy' ? 'busy' : 'no answer'}`
    : c.status === 'voicemail'
      ? 'Missed call, voicemail left'
      : missed || c.status !== 'answered'
        ? 'Missed call'
        : c.answeredBy
          ? `Incoming call, answered by ${c.answeredBy}`
          : 'Incoming call';
  const facts = [
    c.out ? `To ${num(c.toNumber)}` : `From ${num(c.fromNumber)} to ${num(c.toNumber)}`,
    ...(c.talkSeconds ? [mmss(c.talkSeconds)] : []),
    ...(c.recorded ? ['recorded'] : []),
  ];
  const parts = [`<p>${esc(facts.join(' · '))}</p>`];
  const s = summary ? splitSummary(summary) : null;
  if (s?.text.length) parts.push(...s.text.map((l) => `<p>${esc(l)}</p>`));
  if (s?.items.length)
    parts.push(`<p>Action items:</p><ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`);
  return {
    title,
    content: parts.join(''),
    duration: c.talkSeconds ? Math.ceil(c.talkSeconds / 60) : null,
    firstItem: s?.items[0] ?? null,
  };
}

const answerer = alias(extensions, 'answerer');

/**
 * One run of the contrackLog job: calls that ended over a minute ago (and within 2 days), of
 * people who connected Contrack and log calls, not looked at yet. Contrack down: tried again on
 * the next run.
 */
export async function logCallsToContrack(d: {
  db: Db;
  log: { error(o: object, m: string): void };
  now?: Date;
}): Promise<number> {
  const c = await contrackSettings(d.db);
  if (!c) return 0;
  const now = d.now ?? new Date();
  const tz = await getSetting(d.db, 'general.timezone');
  const summariesOn =
    (await getSetting(d.db, 'ai.callTranscripts')) && (await getSetting(d.db, 'ai.callSummaries'));
  const rows = await d.db
    .select({
      call: calls,
      role: callExtensions.role,
      userId: users.id,
      withSummary: users.contrackLogSummaries,
      tokenEnc: users.contrackTokenEnc,
      extId: extensions.id,
      answeredById: answerer.id,
      answeredBy: answerer.name,
      summary: recordings.summary,
      aiDoneAt: recordings.aiDoneAt,
    })
    .from(calls)
    .innerJoin(callExtensions, eq(callExtensions.callId, calls.id))
    .innerJoin(extensions, eq(extensions.id, callExtensions.extensionId))
    .innerJoin(users, eq(users.id, extensions.userId))
    .leftJoin(answerer, eq(answerer.id, calls.answeredByExtensionId))
    .leftJoin(recordings, eq(recordings.id, calls.recordingId))
    .where(
      and(
        isNotNull(users.contrackTokenEnc),
        eq(users.contrackLogCalls, true),
        eq(users.isActive, true),
        ne(calls.direction, 'internal'),
        gt(calls.endedAt, users.contrackLogSince),
        lt(calls.endedAt, new Date(now.getTime() - 60_000)),
        gt(calls.endedAt, new Date(now.getTime() - 2 * 24 * 3600_000)),
        sql`not exists (select 1 from ${contrackCallLog} l where l.call_id = ${calls.id} and l.user_id = ${users.id})`,
      ),
    )
    .orderBy(asc(calls.endedAt))
    .limit(500);

  // One entry per call and person (a person can be in a call as caller, rang and answered).
  const todo = new Map<string, (typeof rows)[number] & { out: boolean }>();
  for (const r of rows) {
    const k = `${r.call.id}|${r.userId}`;
    const out = r.role === 'caller' || todo.get(k)?.out === true;
    todo.set(k, { ...r, out });
  }
  const skipUser = new Set<string>(); // Contrack down or token refused: try again next run
  let logged = 0;
  for (const r of todo.values()) {
    if (skipUser.has(r.userId)) continue;
    const record = (interactionId: string | null, error: string | null = null) =>
      d.db
        .insert(contrackCallLog)
        .values({ callId: r.call.id, userId: r.userId, interactionId, error })
        .onConflictDoNothing();
    const book = await contrackBook(d.db, c, r.userId);
    if (!book || book.error) {
      skipUser.add(r.userId);
      continue;
    }
    const other = r.out ? r.call.toNumber : r.call.fromNumber;
    const contact = other
      ? book.contacts.find((x) => x.numbers.some((n) => n.number === other))
      : undefined;
    if (!contact) {
      await record(null);
      continue;
    }
    const wantSummary = r.withSummary && summariesOn && r.call.recordingId !== null;
    if (wantSummary && !r.aiDoneAt && now.getTime() - r.call.endedAt.getTime() < SUMMARY_WAIT_MS)
      continue; // the transcript job hasn't summarized it yet
    const e = timelineEntry(
      {
        out: r.out,
        status: r.call.status,
        fromNumber: r.call.fromNumber,
        toNumber: r.call.toNumber,
        talkSeconds: r.call.talkSeconds,
        answeredBy: r.answeredById && r.answeredById !== r.extId ? r.answeredBy : null,
        recorded: r.call.recordingId !== null,
      },
      wantSummary ? r.summary : null,
    );
    try {
      const id = await contrackInteraction(c, decrypt(r.tokenEnc!), contact.id, {
        type: 'call',
        title: e.title,
        content: e.content,
        date: r.call.startedAt.toISOString(),
        duration: e.duration,
        source: 'selfphoneng',
        ...(e.firstItem
          ? {
              actionItem: {
                title: e.firstItem.slice(0, 200),
                dueAt: todayIn(tz, new Date(r.call.startedAt.getTime() + 24 * 3600_000)),
              },
            }
          : {}),
      });
      await record(id);
      logged++;
    } catch (err) {
      const status = err instanceof ContrackError ? err.status : undefined;
      // Refused (bad request, a read-only token, a deleted contact): noted, not retried.
      if (status && status >= 400 && status < 500 && status !== 401 && status !== 429)
        await record(null, (err as Error).message);
      else {
        skipUser.add(r.userId);
        d.log.error({ err, user: r.userId }, 'contrack: call not logged yet');
      }
    }
  }
  return logged;
}
