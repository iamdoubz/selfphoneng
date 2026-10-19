// SPDX-License-Identifier: AGPL-3.0-or-later
// Queue stats (04 §7.3 GET /api/queues/:id/stats) from app_queue's AMI events, kept in
// queue_calls. CDRs can't do it: when no agent rings, the Queue part of a call disappears into
// the next leg's CDR (seen on a real call, M8-T1). Asterisk 24 raises QueueCallerAbandon for
// timeouts too, so the dialplan's UserEvent(SpQueueExit, Status: TIMEOUT|FULL|JOINEMPTY…) says
// which callers went on to the timeout destination (03 §6.8).
import type { EventEmitter } from 'node:events';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { QueueStats } from '@selfphoneng/shared';
import { field, type AmiMessage } from '../ami/events.ts';
import type { Db } from '../db/client.ts';
import { extensions, queueCalls, queues } from '../db/schema.ts';
import { todayIn } from '../generator/load.ts';
import { getSetting } from './settings.ts';

export const StatsQuery = z.object({
  /** Company-time-zone days, inclusive; both default to today. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

const QUEUE_EVENTS = new Set(['QueueCallerJoin', 'AgentConnect', 'QueueCallerAbandon']);

/** One app_queue event (or SpQueueExit) → queue_calls. */
export async function recordQueueEvent(db: Db, m: AmiMessage): Promise<void> {
  const ev = field(m, 'Event') === 'UserEvent' ? field(m, 'UserEvent') : field(m, 'Event');
  if (!QUEUE_EVENTS.has(ev ?? '') && ev !== 'SpQueueExit') return;
  const [q] = await db
    .select({ id: queues.id })
    .from(queues)
    .where(eq(queues.number, field(m, 'Queue') ?? ''));
  const uniqueid = field(m, 'Uniqueid') ?? '';
  if (!q || !uniqueid) return;
  if (ev === 'QueueCallerJoin') {
    await db.insert(queueCalls).values({
      queueId: q.id,
      uniqueid,
      linkedid: field(m, 'Linkedid') ?? uniqueid,
    });
    return;
  }
  const [row] = await db
    .select()
    .from(queueCalls)
    .where(and(eq(queueCalls.queueId, q.id), eq(queueCalls.uniqueid, uniqueid)))
    .orderBy(desc(queueCalls.id))
    .limit(1);
  const hold = Number(field(m, 'HoldTime'));
  const waitSeconds = Number.isFinite(hold) ? hold : null;
  if (ev === 'AgentConnect') {
    if (!row) return;
    const ext = /^Local\/(\d+)@/.exec(field(m, 'Interface') ?? '')?.[1] ?? '';
    const [agent] = await db
      .select({ id: extensions.id })
      .from(extensions)
      .where(eq(extensions.number, ext));
    await db
      .update(queueCalls)
      .set({ outcome: 'answered', waitSeconds, agentExtensionId: agent?.id ?? null })
      .where(eq(queueCalls.id, row.id));
  } else if (ev === 'QueueCallerAbandon') {
    if (row && !row.outcome)
      await db
        .update(queueCalls)
        .set({ outcome: 'abandoned', waitSeconds })
        .where(eq(queueCalls.id, row.id));
  } else if (row && row.outcome !== 'answered') {
    // SpQueueExit after waiting (it follows the Abandon event of a timeout)
    await db
      .update(queueCalls)
      .set({
        outcome: 'timed_out',
        waitSeconds: row.waitSeconds ?? Math.round((Date.now() - row.joinedAt.getTime()) / 1000),
      })
      .where(eq(queueCalls.id, row.id));
  } else if (!row) {
    // Turned away at the door (full, or no agents): never joined, but offered all the same.
    await db.insert(queueCalls).values({
      queueId: q.id,
      uniqueid,
      linkedid: field(m, 'Linkedid') ?? uniqueid,
      outcome: 'timed_out',
      waitSeconds: 0,
    });
  }
}

/**
 * ponytail: events that arrive while the api is down are lost (stats undercount for that
 * time); the queue_log file has them if that ever matters.
 */
export function watchQueueCalls(
  d: { db: Db; log: { error(o: object, msg: string): void } },
  ami: Pick<EventEmitter, 'on'>,
) {
  let chain = Promise.resolve(); // in order: an Abandon must land before its SpQueueExit
  ami.on('event', (m: AmiMessage) => {
    chain = chain
      .then(() => recordQueueEvent(d.db, m))
      .catch((err: unknown) => d.log.error({ err }, 'queue event failed'));
  });
}

export async function queueStats(
  db: Db,
  q: { id: string; slaSeconds: number },
  range: z.output<typeof StatsQuery>,
): Promise<QueueStats> {
  const tz = await getSetting(db, 'general.timezone');
  const today = todayIn(tz);
  const from = range.from ?? range.to ?? today;
  const to = range.to ?? range.from ?? today;
  const answered = sql`${queueCalls.outcome} = 'answered'`;
  const [r] = await db
    .select({
      offered: sql<number>`count(*)::int`,
      answered: sql<number>`count(*) filter (where ${answered})::int`,
      abandoned: sql<number>`count(*) filter (where ${queueCalls.outcome} = 'abandoned')::int`,
      timedOut: sql<number>`count(*) filter (where ${queueCalls.outcome} = 'timed_out')::int`,
      avgWait: sql<
        number | null
      >`round(avg(${queueCalls.waitSeconds}) filter (where ${answered}))::int`,
      withinSla: sql<number>`count(*) filter (where ${answered} and ${queueCalls.waitSeconds} <= ${q.slaSeconds})::int`,
      // Service level: answered within the target out of every caller the queue is done with,
      // leaving out callers still waiting and those who hung up before the target (nobody could
      // have answered them in time). Timed out and turned away count as missed.
      slaBase: sql<number>`count(*) filter (where ${queueCalls.outcome} is not null and not (${queueCalls.outcome} = 'abandoned' and ${queueCalls.waitSeconds} <= ${q.slaSeconds}))::int`,
    })
    .from(queueCalls)
    .where(
      and(
        eq(queueCalls.queueId, q.id),
        sql`${queueCalls.joinedAt} >= (${from}::date)::timestamp at time zone ${tz}`,
        sql`${queueCalls.joinedAt} < ((${to}::date + 1)::timestamp at time zone ${tz})`,
      ),
    );
  return {
    offered: r!.offered,
    answered: r!.answered,
    abandoned: r!.abandoned,
    timedOut: r!.timedOut,
    avgWaitSeconds: r!.avgWait,
    withinSlaPercent: r!.slaBase ? Math.round((100 * r!.withinSla) / r!.slaBase) : null,
  };
}
