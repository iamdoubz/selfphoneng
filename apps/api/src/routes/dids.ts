// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/dids: phone numbers and where their calls go (04 §7.3, 06 §3). Admin only.
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DidCreateSchema,
  DidUpdateSchema,
  formatNumber,
  type Destination,
  type DidDto,
  type ListResponse,
} from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { dids, extensions, trunks } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { requireAdmin } from '../auth/guards.ts';
import { audit } from '../services/audit.ts';
import { assertDestinationExists, describeDestination } from '../services/destinations.ts';
import { getSetting, setSetting } from '../services/settings.ts';

type DidRow = typeof dids.$inferSelect;

async function toDto(db: Db, d: DidRow): Promise<DidDto> {
  const destination = d.destination as Destination;
  return {
    id: d.id,
    number: d.number,
    trunkId: d.trunkId,
    label: d.label,
    destination,
    destinationSummary: await describeDestination(db, destination),
    callerIdNamePrefix: d.callerIdNamePrefix,
    recordInbound: d.recordInbound,
    e911Address: d.e911Address,
    createdAt: d.createdAt.toISOString(),
  };
}

const IdParams = z.object({ id: z.uuid() });

async function getDid(db: Db, id: string): Promise<DidRow> {
  const [d] = await db.select().from(dids).where(eq(dids.id, id));
  if (!d) throw notFound('Phone number not found');
  return d;
}

async function assertTrunk(db: Db, id: string) {
  const [t] = await db.select({ id: trunks.id }).from(trunks).where(eq(trunks.id, id));
  if (!t) throw badRequest('That trunk does not exist');
}

const isUniqueViolation = (e: unknown) =>
  ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === '23505';

export async function didRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  app.get('/api/dids', async (): Promise<ListResponse<DidDto>> => {
    const rows = await db.select().from(dids).orderBy(asc(dids.number));
    return { items: await Promise.all(rows.map((d) => toDto(db, d))), nextCursor: null };
  });

  app.get('/api/dids/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return toDto(db, await getDid(db, id));
  });

  app.post('/api/dids', async (req, reply) => {
    const body = DidCreateSchema.parse(req.body);
    await assertTrunk(db, body.trunkId);
    await assertDestinationExists(db, body.destination);
    let created: DidRow;
    try {
      [created] = (await db.insert(dids).values(body).returning()) as [DidRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`${formatNumber(body.number)} is already added`);
      throw e;
    }
    // The first number becomes the company's outbound caller ID (otherwise the provider picks).
    if ((await getSetting(db, 'routing.defaultCallerIdDidId')) === null)
      await setSetting(db, 'routing.defaultCallerIdDidId', created.id);
    const dto = await toDto(db, created);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'did',
      entityId: created.id,
      summary: `Added ${formatNumber(created.number)} → ${dto.destinationSummary}`,
      diff: { after: body },
    });
    app.generator.requestApply('api-change');
    return reply.code(201).send(dto);
  });

  app.patch('/api/dids/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = DidUpdateSchema.parse(req.body);
    const before = await getDid(db, id);
    if (body.trunkId) await assertTrunk(db, body.trunkId);
    if (body.destination) await assertDestinationExists(db, body.destination);
    let after: DidRow;
    try {
      [after] = (await db.update(dids).set(body).where(eq(dids.id, id)).returning()) as [DidRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`${formatNumber(body.number!)} is already added`);
      throw e;
    }
    const changed = (Object.keys(body) as (keyof typeof body)[]).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    const dto = await toDto(db, after);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'did',
      entityId: id,
      summary: `Updated ${formatNumber(after.number)}${changed.length ? ` (${changed.join(', ')})` : ''}`,
      diff: {
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, after[k]])),
      },
    });
    app.generator.requestApply('api-change');
    return dto;
  });

  app.delete('/api/dids/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const d = await getDid(db, id);
    // Caller ID uses fall back quietly (FK set null), but emergency caller IDs must not vanish.
    const usedBy = [
      ...((await getSetting(db, 'emergency.defaultCallerIdDidId')) === id
        ? ['the default emergency caller ID']
        : []),
      ...((await getSetting(db, 'routing.defaultCallerIdDidId')) === id
        ? ['the default outbound caller ID']
        : []),
      ...(
        await db
          .select({ n: extensions.number })
          .from(extensions)
          .where(eq(extensions.emergencyCallerIdDidId, id))
      ).map((r) => `the emergency caller ID of extension ${r.n}`),
    ];
    if (usedBy.length)
      throw conflict(`${formatNumber(d.number)} is still ${usedBy.join(', ')}`, { usedBy });
    await db.delete(dids).where(eq(dids.id, id));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'did',
      entityId: id,
      summary: `Removed ${formatNumber(d.number)}`,
      diff: { before: d },
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });
}
