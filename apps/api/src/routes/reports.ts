// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/reports (04 §7.3, 05 §2 Reports): calls per day, busiest hours, per-queue stats. Admin only.
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  CALL_DIRECTIONS,
  ReportRangeSchema,
  type ListResponse,
  type QueueReportRow,
  type ProviderBalanceDto,
  type ReportSummary,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import type { Db } from '../db/client.ts';
import { decrypt } from '../crypto/secrets.ts';
import { calls, queues, trunks } from '../db/schema.ts';
import { getBalance, VoipmsError } from '../integrations/voipms/client.ts';
import { badRequest } from '../errors.ts';
import { todayIn } from '../generator/load.ts';
import { queueStats } from '../services/queuestats.ts';
import { getSetting } from '../services/settings.ts';

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Whole days in the company time zone; the last 30 days by default, a year at most. */
async function range(db: Db, query: unknown) {
  const r = ReportRangeSchema.parse(query);
  const tz = await getSetting(db, 'general.timezone');
  const to = r.to ?? (r.from ? addDays(r.from, 29) : todayIn(tz));
  const from = r.from ?? addDays(to, -29);
  if (addDays(from, 366) <= to) throw badRequest('Pick at most a year');
  return { tz, from, to };
}

export async function reportRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  app.get('/api/reports/summary', async (req): Promise<ReportSummary> => {
    const { tz, from, to } = await range(db, req.query);
    const where = and(
      sql`${calls.startedAt} >= (${from}::date)::timestamp at time zone ${tz}`,
      sql`${calls.startedAt} < ((${to}::date + 1)::timestamp at time zone ${tz})`,
    );
    const local = sql`(${calls.startedAt} at time zone ${tz})`;
    const missed = sql`${calls.status} in ('missed', 'voicemail', 'abandoned')`;
    // Outside line time: inbound from arrival (a receptionist or voicemail answers too),
    // outbound from the answer (talk time).
    const lineIn = sql`coalesce(sum(extract(epoch from ${calls.endedAt} - ${calls.startedAt})) filter (where ${calls.direction} = 'inbound'), 0)`;
    const lineOut = sql`coalesce(sum(${calls.talkSeconds}) filter (where ${calls.direction} = 'outbound'), 0)`;
    const [perDay, perHour, [t]] = await Promise.all([
      db
        .select({
          date: sql<string>`to_char(${local}, 'YYYY-MM-DD')`,
          direction: calls.direction,
          n: sql<number>`count(*)::int`,
          missed: sql<number>`count(*) filter (where ${missed})::int`,
          outside: sql<number>`round(${lineIn} + ${lineOut})::int`,
        })
        .from(calls)
        .where(where)
        .groupBy(sql`1`, calls.direction),
      db
        .select({
          dow: sql<number>`extract(dow from ${local})::int`,
          hour: sql<number>`extract(hour from ${local})::int`,
          n: sql<number>`count(*)::int`,
        })
        .from(calls)
        .where(where)
        .groupBy(sql`1`, sql`2`),
      db
        .select({
          calls: sql<number>`count(*)::int`,
          answered: sql<number>`count(*) filter (where ${calls.status} = 'answered')::int`,
          missed: sql<number>`count(*) filter (where ${missed})::int`,
          talk: sql<number>`coalesce(sum(${calls.talkSeconds}), 0)::int`,
          lineIn: sql<number>`round(${lineIn})::int`,
          lineOut: sql<number>`${lineOut}::int`,
          avgTalk: sql<
            number | null
          >`round(avg(${calls.talkSeconds}) filter (where ${calls.status} = 'answered'))::int`,
        })
        .from(calls)
        .where(where),
    ]);
    const days: ReportSummary['days'] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const rows = perDay.filter((r) => r.date === d);
      days.push({
        date: d,
        ...(Object.fromEntries(
          CALL_DIRECTIONS.map((dir) => [dir, rows.find((r) => r.direction === dir)?.n ?? 0]),
        ) as Record<(typeof CALL_DIRECTIONS)[number], number>),
        missed: rows.reduce((s, r) => s + r.missed, 0),
        outsideMinutes: Math.round(rows.reduce((s, r) => s + r.outside, 0) / 60),
      });
    }
    const hours = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const h of perHour) hours[h.dow]![h.hour] = h.n;
    return {
      from,
      to,
      days,
      totals: {
        calls: t!.calls,
        answered: t!.answered,
        missed: t!.missed,
        avgTalkSeconds: t!.avgTalk,
        talkSeconds: t!.talk,
        outsideSeconds: { inbound: t!.lineIn, outbound: t!.lineOut },
      },
      hours,
    };
  });

  /** Each voip.ms trunk's account balance (owner, 2026-10-21); a trunk without API login says so. */
  app.get('/api/reports/balance', async (): Promise<ListResponse<ProviderBalanceDto>> => {
    const rows = await db
      .select()
      .from(trunks)
      .where(eq(trunks.provider, 'voipms'))
      .orderBy(asc(trunks.name));
    const items = await Promise.all(
      rows.map(async (t): Promise<ProviderBalanceDto> => {
        const base = { trunkId: t.id, trunkName: t.name };
        if (!t.voipmsApiUsername || !t.voipmsApiPasswordEnc)
          return {
            ...base,
            balance: null,
            error: 'Add the voip.ms API username and password to this trunk (Trunks) to see it',
          };
        try {
          const creds = {
            username: t.voipmsApiUsername,
            password: decrypt(t.voipmsApiPasswordEnc),
          };
          return {
            ...base,
            balance: await getBalance(app.config.VOIPMS_API_URL, creds),
            error: null,
          };
        } catch (e) {
          if (e instanceof VoipmsError) return { ...base, balance: null, error: e.message };
          throw e;
        }
      }),
    );
    return { items, nextCursor: null };
  });

  app.get('/api/reports/queues', async (req): Promise<ListResponse<QueueReportRow>> => {
    const { from, to } = await range(db, req.query);
    const qs = await db.select().from(queues).orderBy(asc(queues.number));
    return {
      nextCursor: null,
      items: await Promise.all(
        qs.map(async (q) => ({
          id: q.id,
          number: q.number,
          name: q.name,
          slaSeconds: q.slaSeconds,
          ...(await queueStats(db, q, { from, to })),
        })),
      ),
    };
  });
}
