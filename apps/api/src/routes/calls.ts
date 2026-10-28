// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/calls (admin) and /api/me/calls (04 §7.3): call history, newest first, keyset paging.
// /api/me/spam-reports: Report spam on a call that rang me (05 §4).
import { and, asc, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  CallFilterSchema,
  SpamReportCreateSchema,
  formatNumber,
  normalizeNumber,
  type CallDetailDto,
  type CallDto,
  type ListResponse,
  type MyCallDto,
  type SpamCheck,
} from '@selfphoneng/shared';
import { requireAdmin, requireAuth } from '../auth/guards.ts';
import type { Db } from '../db/client.ts';
import {
  blockedNumbers,
  callExtensions,
  calls,
  cdr,
  dids,
  extensions,
  spamReports,
} from '../db/schema.ts';
import { contactNames } from '../contacts/book.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { getSetting } from '../services/settings.ts';

const answerer = alias(extensions, 'answerer');
type Filter = z.output<typeof CallFilterSchema>;

const MISSED = ['missed', 'voicemail', 'abandoned'] as const;

/** Keyset cursor: the last row's start time and id. */
const encodeCursor = (c: { startedAt: Date; id: string }) =>
  Buffer.from(`${c.startedAt.toISOString()}|${c.id}`).toString('base64url');
function decodeCursor(s: string): { at: Date; id: string } {
  const [at, id] = Buffer.from(s, 'base64url').toString().split('|');
  const d = new Date(at ?? '');
  if (Number.isNaN(d.getTime()) || !id) throw badRequest('Bad cursor');
  return { at: d, id };
}

async function conditions(db: Db, f: Filter): Promise<SQL[]> {
  const tz = await getSetting(db, 'general.timezone');
  const where: SQL[] = [];
  // Whole days in the company time zone.
  if (f.from)
    where.push(sql`${calls.startedAt} >= (${f.from}::date)::timestamp at time zone ${tz}`);
  if (f.to)
    where.push(sql`${calls.startedAt} < ((${f.to}::date + 1)::timestamp at time zone ${tz})`);
  if (f.direction) where.push(eq(calls.direction, f.direction));
  if (f.status) where.push(eq(calls.status, f.status));
  if (f.didId) where.push(eq(calls.didId, f.didId));
  if (f.extensionId)
    where.push(
      inArray(
        calls.id,
        db
          .select({ id: callExtensions.callId })
          .from(callExtensions)
          .where(eq(callExtensions.extensionId, f.extensionId)),
      ),
    );
  const digits = f.q?.replace(/\D/g, '');
  if (digits)
    where.push(or(ilike(calls.fromNumber, `%${digits}%`), ilike(calls.toNumber, `%${digits}%`))!);
  if (f.cursor) {
    const c = decodeCursor(f.cursor);
    where.push(
      sql`(${calls.startedAt}, ${calls.id}) < (${c.at.toISOString()}::timestamptz, ${c.id}::uuid)`,
    );
  }
  return where;
}

/** `viewer`: whose books hide the spam check for a number they name (14 §6). */
async function page(db: Db, where: SQL[], limit: number, viewer: string) {
  const rows = await db
    .select({ c: calls, did: dids, a: answerer })
    .from(calls)
    .leftJoin(dids, eq(dids.id, calls.didId))
    .leftJoin(answerer, eq(answerer.id, calls.answeredByExtensionId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(calls.startedAt), desc(calls.id))
    .limit(limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const known = await contactNames(
    db,
    viewer,
    items.filter(({ c }) => c.spamRisk).map(({ c }) => c.fromNumber),
    { wait: false },
  ).catch(() => null);
  return {
    items: items.map(({ c, did, a }): CallDto => ({
      id: c.id,
      direction: c.direction,
      status: c.status,
      startedAt: c.startedAt.toISOString(),
      answeredAt: c.answeredAt?.toISOString() ?? null,
      endedAt: c.endedAt.toISOString(),
      fromNumber: c.fromNumber,
      fromName: c.fromName,
      toNumber: c.toNumber,
      did: did ? { id: did.id, number: did.number, label: did.label } : null,
      answeredBy: a ? { id: a.id, number: a.number, name: a.name } : null,
      talkSeconds: c.talkSeconds,
      recordingId: c.recordingId,
      spam:
        c.spamRisk && known && !known.has(c.fromNumber ?? '')
          ? ({ risk: c.spamRisk, ...(c.spamInfo as object) } as SpamCheck)
          : null,
    })),
    nextCursor: more ? encodeCursor(items.at(-1)!.c) : null,
  };
}

/** RFC 4180, and cells that a spreadsheet would run as a formula get a leading quote. */
export const csvCell = (v: string | number | null) => {
  let s = v === null ? '' : String(v);
  if (/^[=@\t\r]/.test(s) || (/^[-+]/.test(s) && !/^\+?\d+$/.test(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function callRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get(
    '/api/calls',
    { preHandler: requireAdmin },
    async (req): Promise<ListResponse<CallDto>> => {
      const f = CallFilterSchema.parse(req.query);
      return page(db, await conditions(db, f), f.limit, req.user!.id);
    },
  );

  app.get('/api/calls/export.csv', { preHandler: requireAdmin }, async (req, reply) => {
    const f = CallFilterSchema.parse({ ...(req.query as object), limit: 200 });
    const tz = await getSetting(db, 'general.timezone');
    const where = await conditions(db, { ...f, cursor: undefined });
    const out = [
      'started,direction,status,from,from_name,to,phone_number,answered_by,talk_seconds',
    ];
    // ponytail: one query capped at 50,000 rows; stream with a cursor if exports get bigger.
    const { items } = await page(db, where, 50_000, req.user!.id);
    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      dateStyle: 'short',
      timeStyle: 'medium',
    });
    for (const c of items)
      out.push(
        [
          fmt.format(new Date(c.startedAt)),
          c.direction,
          c.status,
          c.fromNumber,
          c.fromName,
          c.toNumber,
          c.did?.number ?? null,
          c.answeredBy ? `${c.answeredBy.number} ${c.answeredBy.name}` : null,
          c.talkSeconds,
        ]
          .map(csvCell)
          .join(','),
      );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="calls-${f.from ?? 'all'}-${f.to ?? 'now'}.csv"`,
      )
      .send(out.join('\r\n') + '\r\n');
  });

  app.get('/api/calls/:id', { preHandler: requireAdmin }, async (req): Promise<CallDetailDto> => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { items } = await page(db, [eq(calls.id, id)], 1, req.user!.id);
    const [c] = await db.select({ linkedid: calls.linkedid }).from(calls).where(eq(calls.id, id));
    if (!items[0] || !c) throw notFound('Call not found');
    const legs = await db
      .select()
      .from(cdr)
      .where(eq(cdr.linkedid, c.linkedid))
      .orderBy(asc(cdr.startAt), asc(cdr.id));
    return {
      ...items[0],
      linkedid: c.linkedid,
      legs: legs.map((l) => ({
        startAt: l.startAt?.toISOString() ?? null,
        channel: l.channel,
        dstchannel: l.dstchannel,
        lastapp: l.lastapp,
        disposition: l.disposition,
        billsec: l.billsec,
      })),
    };
  });

  app.get(
    '/api/me/calls',
    { preHandler: requireAuth },
    async (req): Promise<ListResponse<MyCallDto>> => {
      const f = CallFilterSchema.pick({ cursor: true, limit: true }).parse(req.query);
      const [ext] = await db
        .select({ id: extensions.id })
        .from(extensions)
        .where(eq(extensions.userId, req.user!.id));
      if (!ext) throw notFound("You don't have an extension yet. Ask your admin.");
      const where = await conditions(db, { ...f, extensionId: ext.id });
      const result = await page(db, where, f.limit, req.user!.id);
      const ids = result.items.map((c) => c.id);
      const roles = ids.length
        ? await db
            .select({ callId: callExtensions.callId, role: callExtensions.role })
            .from(callExtensions)
            .where(and(eq(callExtensions.extensionId, ext.id), inArray(callExtensions.callId, ids)))
        : [];
      return {
        items: result.items.map((c) => {
          const mine = roles.filter((r) => r.callId === c.id).map((r) => r.role);
          const out = mine.includes('caller');
          return {
            ...c,
            myRole: out ? 'out' : 'in',
            missedByMe: !out && (MISSED as readonly string[]).includes(c.status),
          };
        }),
        nextCursor: result.nextCursor,
      };
    },
  );

  /** The admins see it on Blocked numbers and block or dismiss it. */
  app.post('/api/me/spam-reports', { preHandler: requireAuth }, async (req, reply) => {
    const body = SpamReportCreateSchema.parse(req.body);
    const [c] = await db
      .select({ number: calls.fromNumber })
      .from(calls)
      .innerJoin(callExtensions, eq(callExtensions.callId, calls.id))
      .innerJoin(extensions, eq(extensions.id, callExtensions.extensionId))
      .where(
        and(
          eq(calls.id, body.callId),
          eq(calls.direction, 'inbound'),
          eq(extensions.userId, req.user!.id),
          ne(callExtensions.role, 'caller'),
        ),
      )
      .limit(1);
    if (!c) throw notFound('Not a call from outside that rang you');
    let number: string;
    try {
      number = normalizeNumber(c.number ?? '');
    } catch {
      throw badRequest("This caller's number was hidden, so it can't be blocked");
    }
    const [blocked] = await db
      .select({ id: blockedNumbers.id })
      .from(blockedNumbers)
      .where(eq(blockedNumbers.number, number));
    if (blocked) throw conflict(`${formatNumber(number)} is already blocked`);
    const [r] = await db
      .insert(spamReports)
      .values({ number, reason: body.reason, reportedBy: req.user!.id })
      .onConflictDoNothing()
      .returning();
    if (!r) throw conflict(`You already reported ${formatNumber(number)}`);
    return reply.code(201).send({ ok: true });
  });
}
