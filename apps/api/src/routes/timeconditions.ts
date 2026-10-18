// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/time-conditions (office hours) and /api/holidays (04 §7.3). Admin only.
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  HolidaySchema,
  OverrideBodySchema,
  TimeConditionCreateSchema,
  TimeConditionUpdateSchema,
  timeConditionStatus,
  type Destination,
  type HolidayDto,
  type ListResponse,
  type OpenRange,
  type TimeConditionDto,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import { holidays, timeConditions } from '../db/schema.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import { setTcOverride } from '../services/astdb.ts';
import { audit } from '../services/audit.ts';
import { assertDestinationExists, findReferences } from '../services/destinations.ts';
import { usFederalHolidays } from '../services/holidays.ts';
import { getSetting } from '../services/settings.ts';

type TcRow = typeof timeConditions.$inferSelect;
type HolidayRow = typeof holidays.$inferSelect;

const holidayDto = (h: HolidayRow): HolidayDto => ({
  id: h.id,
  name: h.name,
  startDate: h.startDate,
  endDate: h.endDate,
  recurringYearly: h.recurringYearly,
});

function tcDto(t: TcRow, hs: HolidayRow[], now = new Date()): TimeConditionDto {
  const base = {
    timezone: t.timezone,
    openRanges: t.openRanges as OpenRange[],
    useHolidays: t.useHolidays,
    overrideState: t.overrideState as 'open' | 'closed' | null,
  };
  return {
    id: t.id,
    name: t.name,
    ...base,
    overrideDigit: t.overrideDigit,
    openDestination: t.openDestination as Destination,
    closedDestination: t.closedDestination as Destination,
    holidayDestination: t.holidayDestination as Destination | null,
    status: timeConditionStatus(base, hs, now),
    createdAt: t.createdAt.toISOString(),
  };
}

const IdParams = z.object({ id: z.uuid() });
const isUniqueViolation = (e: unknown) =>
  ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === '23505';
const digitTaken = (d: number | null | undefined) =>
  conflict(`Override digit ${d} is used by other office hours (*31${d}, *32${d}, *33${d})`);

export async function timeConditionRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);
  const allHolidays = () => db.select().from(holidays).orderBy(asc(holidays.startDate));

  async function getTc(id: string) {
    const [t] = await db.select().from(timeConditions).where(eq(timeConditions.id, id));
    if (!t) throw notFound('Office hours not found');
    return t;
  }
  const checkDests = async (ds: (Destination | null | undefined)[], self?: string) => {
    for (const d of ds) {
      if (!d) continue;
      if (self && d.type === 'time_condition' && d.id === self)
        throw badRequest("Office hours can't send calls to themselves");
      await assertDestinationExists(db, d);
    }
  };

  app.get('/api/time-conditions', async (): Promise<ListResponse<TimeConditionDto>> => {
    const [rows, hs] = await Promise.all([
      db.select().from(timeConditions).orderBy(asc(timeConditions.name)),
      allHolidays(),
    ]);
    return { items: rows.map((t) => tcDto(t, hs)), nextCursor: null };
  });

  app.get('/api/time-conditions/:id', async (req) =>
    tcDto(await getTc(IdParams.parse(req.params).id), await allHolidays()),
  );

  app.get('/api/time-conditions/:id/status', async (req) => {
    const t = await getTc(IdParams.parse(req.params).id);
    return tcDto(t, await allHolidays()).status;
  });

  app.post('/api/time-conditions', async (req, reply) => {
    const body = TimeConditionCreateSchema.parse(req.body);
    await checkDests([body.openDestination, body.closedDestination, body.holidayDestination]);
    const values = {
      ...body,
      timezone: body.timezone ?? (await getSetting(db, 'general.timezone')),
      openRanges: body.openRanges ?? [],
    };
    let created: TcRow;
    try {
      [created] = (await db.insert(timeConditions).values(values).returning()) as [TcRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw digitTaken(body.overrideDigit);
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'time_condition',
      entityId: created.id,
      summary: `Created office hours ${created.name}`,
      diff: { after: values },
    });
    app.generator.requestApply('api-change');
    return reply.code(201).send(tcDto(created, await allHolidays()));
  });

  app.patch('/api/time-conditions/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = TimeConditionUpdateSchema.parse(req.body);
    await getTc(id);
    await checkDests([body.openDestination, body.closedDestination, body.holidayDestination], id);
    let after: TcRow;
    try {
      [after] = (await db
        .update(timeConditions)
        .set(body)
        .where(eq(timeConditions.id, id))
        .returning()) as [TcRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw digitTaken(body.overrideDigit);
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'time_condition',
      entityId: id,
      summary: `Updated office hours ${after.name}`,
      diff: { after: body },
    });
    app.generator.requestApply('api-change');
    return tcDto(after, await allHolidays());
  });

  /** Force open / force closed / back to automatic; the dialplan reads AstDB SP/TCOVR/<id>. */
  app.post('/api/time-conditions/:id/override', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { state } = OverrideBodySchema.parse(req.body);
    const t = await getTc(id);
    if (!app.ami.isConnected())
      throw new HttpError(503, 'unavailable', 'Asterisk is not connected');
    const overrideState = state === 'auto' ? null : state;
    const [after] = (await db
      .update(timeConditions)
      .set({ overrideState })
      .where(eq(timeConditions.id, id))
      .returning()) as [TcRow];
    await setTcOverride(app.ami, id, overrideState);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'time_condition',
      entityId: id,
      summary: `${t.name}: ${state === 'auto' ? 'back to automatic' : `forced ${state}`}`,
    });
    return tcDto(after, await allHolidays());
  });

  app.delete('/api/time-conditions/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const t = await getTc(id);
    const usedBy = await findReferences(db, 'time_condition', id);
    if (usedBy.length)
      throw conflict(`${t.name} is still used by ${usedBy.join(', ')}`, { usedBy });
    await db.delete(timeConditions).where(eq(timeConditions.id, id));
    if (t.overrideState && app.ami.isConnected()) await setTcOverride(app.ami, id, null);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'time_condition',
      entityId: id,
      summary: `Deleted office hours ${t.name}`,
      diff: { before: t },
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });

  // ─── Holidays: global, used by every office hours with "use holidays" on.
  app.get('/api/holidays', async (): Promise<ListResponse<HolidayDto>> => ({
    items: (await allHolidays()).map(holidayDto),
    nextCursor: null,
  }));

  app.post('/api/holidays', async (req, reply) => {
    const body = HolidaySchema.parse(req.body);
    const [h] = (await db.insert(holidays).values(body).returning()) as [HolidayRow];
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'holiday',
      entityId: h.id,
      summary: `Added holiday ${h.name} (${h.startDate})`,
    });
    app.generator.requestApply('api-change');
    return reply.code(201).send(holidayDto(h));
  });

  app.patch('/api/holidays/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = HolidaySchema.parse(req.body); // whole holiday: the date rules need both ends
    const [h] = (await db.update(holidays).set(body).where(eq(holidays.id, id)).returning()) as [
      HolidayRow | undefined,
    ];
    if (!h) throw notFound('Holiday not found');
    app.generator.requestApply('api-change');
    return holidayDto(h);
  });

  app.delete('/api/holidays/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const [h] = await db.delete(holidays).where(eq(holidays.id, id)).returning();
    if (!h) throw notFound('Holiday not found');
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'holiday',
      entityId: id,
      summary: `Removed holiday ${h.name} (${h.startDate})`,
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });

  /** Adds the year's US federal holidays (observed dates); skips any already listed that day. */
  app.post('/api/holidays/import-us-federal', async (req) => {
    const { year } = z.object({ year: z.number().int().min(2000).max(2100) }).parse(req.body);
    const have = new Set((await allHolidays()).map((h) => h.startDate));
    const add = usFederalHolidays(year).filter((h) => !have.has(h.date));
    if (add.length)
      await db
        .insert(holidays)
        .values(add.map((h) => ({ name: h.name, startDate: h.date, endDate: h.date })));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'holiday',
      summary: `Added ${add.length} US federal holidays for ${year}`,
    });
    if (add.length) app.generator.requestApply('api-change');
    return { added: add.length };
  });
}
