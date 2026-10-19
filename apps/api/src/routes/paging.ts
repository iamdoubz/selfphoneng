// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/paging-groups (04 §7.3): members are sent as `memberIds`. Paging groups aren't call
// destinations, so nothing else points at them and delete never needs a check. Admin only.
import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PagingGroupCreateSchema,
  PagingGroupUpdateSchema,
  type ListResponse,
  type PagingGroupDto,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import type { Db } from '../db/client.ts';
import { extensions, pagingGroupMembers, pagingGroups } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';
import { assertNumberAvailable } from '../services/numbering.ts';

type Row = typeof pagingGroups.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function toDto(db: Db, g: Row): Promise<PagingGroupDto> {
  const members = await db
    .select({ id: pagingGroupMembers.extensionId })
    .from(pagingGroupMembers)
    .innerJoin(extensions, eq(extensions.id, pagingGroupMembers.extensionId))
    .where(eq(pagingGroupMembers.pagingGroupId, g.id))
    .orderBy(asc(extensions.number));
  return {
    id: g.id,
    number: g.number,
    name: g.name,
    duplex: g.duplex,
    memberIds: members.map((m) => m.id),
    createdAt: g.createdAt.toISOString(),
  };
}

async function assertMembers(db: Db, ids: string[]) {
  if (!ids.length) return;
  const found = await db
    .select({ id: extensions.id })
    .from(extensions)
    .where(inArray(extensions.id, ids));
  if (found.length !== ids.length) throw badRequest('One of the members no longer exists');
}

async function setMembers(db: Db | Tx, id: string, ids: string[]) {
  await db.delete(pagingGroupMembers).where(eq(pagingGroupMembers.pagingGroupId, id));
  if (ids.length)
    await db
      .insert(pagingGroupMembers)
      .values(ids.map((extensionId) => ({ pagingGroupId: id, extensionId })));
}

const IdParams = z.object({ id: z.uuid() });
const isUniqueViolation = (e: unknown) =>
  ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === '23505';

export async function pagingRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  async function getGroup(id: string) {
    const [g] = await db.select().from(pagingGroups).where(eq(pagingGroups.id, id));
    if (!g) throw notFound('Paging group not found');
    return g;
  }

  app.get('/api/paging-groups', async (): Promise<ListResponse<PagingGroupDto>> => {
    const rows = await db.select().from(pagingGroups).orderBy(asc(pagingGroups.number));
    return { items: await Promise.all(rows.map((g) => toDto(db, g))), nextCursor: null };
  });

  app.get('/api/paging-groups/:id', async (req) =>
    toDto(db, await getGroup(IdParams.parse(req.params).id)),
  );

  app.post('/api/paging-groups', async (req, reply) => {
    const { memberIds = [], ...body } = PagingGroupCreateSchema.parse(req.body);
    await assertNumberAvailable(db, body.number, 'paging');
    await assertMembers(db, memberIds);
    let created: Row;
    try {
      created = await db.transaction(async (tx) => {
        const [g] = (await tx.insert(pagingGroups).values(body).returning()) as [Row];
        await setMembers(tx, g.id, memberIds);
        return g;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`${body.number} is already taken`);
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'paging_group',
      entityId: created.id,
      summary: `Created paging group ${created.number} (${created.name})`,
      diff: { after: { ...body, memberIds } },
    });
    app.generator.requestApply('api-change');
    return reply.code(201).send(await toDto(db, created));
  });

  app.patch('/api/paging-groups/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { memberIds, ...body } = PagingGroupUpdateSchema.parse(req.body);
    const before = await getGroup(id);
    if (body.number && body.number !== before.number)
      await assertNumberAvailable(db, body.number, 'paging', id);
    if (memberIds) await assertMembers(db, memberIds);
    let after: Row;
    try {
      after = await db.transaction(async (tx) => {
        const [g] = Object.keys(body).length
          ? ((await tx
              .update(pagingGroups)
              .set(body)
              .where(eq(pagingGroups.id, id))
              .returning()) as [Row])
          : [before];
        if (memberIds) await setMembers(tx, id, memberIds);
        return g;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`${body.number} is already taken`);
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'paging_group',
      entityId: id,
      summary: `Updated paging group ${after.number} (${after.name})`,
      diff: { after: { ...body, ...(memberIds ? { memberIds } : {}) } },
    });
    app.generator.requestApply('api-change');
    return toDto(db, after);
  });

  app.delete('/api/paging-groups/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const g = await getGroup(id);
    await db.delete(pagingGroups).where(eq(pagingGroups.id, id));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'paging_group',
      entityId: id,
      summary: `Deleted paging group ${g.number} (${g.name})`,
      diff: { before: g },
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });
}
