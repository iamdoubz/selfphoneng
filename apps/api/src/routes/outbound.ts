// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/outbound-routes (04 §7.3, 03 §6.12). Admin only. Position = match order.
import { asc, eq, inArray, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  OutboundRouteCreateSchema,
  OutboundRouteUpdateSchema,
  RouteTestSchema,
  type ListResponse,
  type OutboundRouteDto,
  type RoutePattern,
} from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { dids, outboundRoutes, trunks } from '../db/schema.ts';
import { badRequest, notFound } from '../errors.ts';
import { requireAdmin } from '../auth/guards.ts';
import { audit } from '../services/audit.ts';
import { testRoute } from '../services/outbound.ts';

type RouteRow = typeof outboundRoutes.$inferSelect;

const toDto = (r: RouteRow): OutboundRouteDto => ({
  id: r.id,
  name: r.name,
  position: r.position,
  enabled: r.enabled,
  patterns: r.patterns as RoutePattern[],
  requiredClass: r.requiredClass,
  trunkIds: r.trunkIds,
  callerIdDidId: r.callerIdDidId,
  createdAt: r.createdAt.toISOString(),
});

const IdParams = z.object({ id: z.uuid() });

async function getRoute(db: Db, id: string): Promise<RouteRow> {
  const [r] = await db.select().from(outboundRoutes).where(eq(outboundRoutes.id, id));
  if (!r) throw notFound('Outbound rule not found');
  return r;
}

/** trunk_ids is a plain uuid[] (no FK), so check it here. */
async function checkRefs(db: Db, b: { trunkIds?: string[]; callerIdDidId?: string | null }) {
  if (b.trunkIds) {
    if (new Set(b.trunkIds).size !== b.trunkIds.length) throw badRequest('A trunk is listed twice');
    const found = await db
      .select({ id: trunks.id })
      .from(trunks)
      .where(inArray(trunks.id, b.trunkIds));
    if (found.length !== b.trunkIds.length) throw badRequest('One of those trunks does not exist');
  }
  if (b.callerIdDidId) {
    const [d] = await db.select({ id: dids.id }).from(dids).where(eq(dids.id, b.callerIdDidId));
    if (!d) throw badRequest('That caller ID number does not exist');
  }
}

export async function outboundRouteRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  app.get('/api/outbound-routes', async (): Promise<ListResponse<OutboundRouteDto>> => {
    const rows = await db
      .select()
      .from(outboundRoutes)
      .orderBy(asc(outboundRoutes.position), asc(outboundRoutes.id));
    return { items: rows.map(toDto), nextCursor: null };
  });

  app.get('/api/outbound-routes/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return toDto(await getRoute(db, id));
  });

  app.post('/api/outbound-routes', async (req, reply) => {
    const body = OutboundRouteCreateSchema.parse(req.body);
    await checkRefs(db, body);
    const [{ last }] = (await db
      .select({ last: max(outboundRoutes.position) })
      .from(outboundRoutes)) as [{ last: number | null }];
    const [created] = (await db
      .insert(outboundRoutes)
      .values({ ...body, position: (last ?? -1) + 1 })
      .returning()) as [RouteRow];
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'outbound_route',
      entityId: created.id,
      summary: `Created outbound rule ${created.name}`,
      diff: { after: body },
    });
    app.generator.requestApply('api-change');
    return reply.code(201).send(toDto(created));
  });

  app.patch('/api/outbound-routes/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = OutboundRouteUpdateSchema.parse(req.body);
    const before = await getRoute(db, id);
    await checkRefs(db, body);
    const [after] = (await db
      .update(outboundRoutes)
      .set(body)
      .where(eq(outboundRoutes.id, id))
      .returning()) as [RouteRow];
    const changed = (Object.keys(body) as (keyof typeof body)[]).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'outbound_route',
      entityId: id,
      summary: `Updated outbound rule ${after.name}${changed.length ? ` (${changed.join(', ')})` : ''}`,
      diff: {
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, after[k]])),
      },
    });
    app.generator.requestApply('api-change');
    return toDto(after);
  });

  app.delete('/api/outbound-routes/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const r = await getRoute(db, id);
    await db.delete(outboundRoutes).where(eq(outboundRoutes.id, id));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'outbound_route',
      entityId: id,
      summary: `Deleted outbound rule ${r.name}`,
      diff: { before: toDto(r) },
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });

  /** The full new order: every route id exactly once. */
  app.post('/api/outbound-routes/reorder', async (req) => {
    const { ids } = z.object({ ids: z.array(z.uuid()) }).parse(req.body);
    const all = await db.select({ id: outboundRoutes.id }).from(outboundRoutes);
    if (
      ids.length !== all.length ||
      new Set(ids).size !== ids.length ||
      all.some((r) => !ids.includes(r.id))
    )
      throw badRequest('Send every outbound rule exactly once');
    await db.transaction(async (tx) => {
      for (const [position, id] of ids.entries())
        await tx.update(outboundRoutes).set({ position }).where(eq(outboundRoutes.id, id));
    });
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'reorder',
      entityType: 'outbound_route',
      summary: 'Reordered outbound rules',
      diff: { after: ids },
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });

  app.post('/api/outbound-routes/test', async (req) => {
    const { extensionId, number } = RouteTestSchema.parse(req.body);
    return testRoute(db, extensionId, number);
  });
}
