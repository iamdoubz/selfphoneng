// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/ring-groups (04 §7.3): members are sent as `memberIds` in ring order. Admin only.
import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  RingGroupCreateSchema,
  RingGroupUpdateSchema,
  type Destination,
  type ListResponse,
  type RingGroupDto,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import type { Db } from '../db/client.ts';
import { extensions, ringGroupMembers, ringGroups } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';
import {
  assertDestinationExists,
  describeDestination,
  findReferences,
} from '../services/destinations.ts';
import { assertNumberAvailable } from '../services/numbering.ts';

type Row = typeof ringGroups.$inferSelect;

async function memberIdsOf(db: Db, id: string): Promise<string[]> {
  const rows = await db
    .select({ id: ringGroupMembers.extensionId })
    .from(ringGroupMembers)
    .where(eq(ringGroupMembers.ringGroupId, id))
    .orderBy(asc(ringGroupMembers.position));
  return rows.map((r) => r.id);
}

async function toDto(db: Db, g: Row): Promise<RingGroupDto> {
  const noAnswerDestination = g.noAnswerDestination as Destination;
  return {
    id: g.id,
    number: g.number,
    name: g.name,
    strategy: g.strategy,
    ringSeconds: g.ringSeconds,
    callerIdNamePrefix: g.callerIdNamePrefix,
    musicInsteadOfRing: g.musicInsteadOfRing,
    memberIds: await memberIdsOf(db, g.id),
    noAnswerDestination,
    noAnswerSummary: await describeDestination(db, noAnswerDestination),
    createdAt: g.createdAt.toISOString(),
  };
}

const IdParams = z.object({ id: z.uuid() });

async function assertMembers(db: Db, ids: string[]) {
  if (!ids.length) return;
  const found = await db
    .select({ id: extensions.id })
    .from(extensions)
    .where(inArray(extensions.id, ids));
  if (found.length !== ids.length) throw badRequest('One of the members no longer exists');
}

/** Replaces the member list (position = index). */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function setMembers(db: Db | Tx, id: string, ids: string[]) {
  await db.delete(ringGroupMembers).where(eq(ringGroupMembers.ringGroupId, id));
  if (ids.length)
    await db
      .insert(ringGroupMembers)
      .values(ids.map((extensionId, position) => ({ ringGroupId: id, extensionId, position })));
}

const isUniqueViolation = (e: unknown) =>
  ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === '23505';

export async function ringGroupRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  async function getGroup(id: string) {
    const [g] = await db.select().from(ringGroups).where(eq(ringGroups.id, id));
    if (!g) throw notFound('Ring group not found');
    return g;
  }

  app.get('/api/ring-groups', async (): Promise<ListResponse<RingGroupDto>> => {
    const rows = await db.select().from(ringGroups).orderBy(asc(ringGroups.number));
    return { items: await Promise.all(rows.map((g) => toDto(db, g))), nextCursor: null };
  });

  app.get('/api/ring-groups/:id', async (req) =>
    toDto(db, await getGroup(IdParams.parse(req.params).id)),
  );

  app.post('/api/ring-groups', async (req, reply) => {
    const { memberIds = [], ...body } = RingGroupCreateSchema.parse(req.body);
    await assertNumberAvailable(db, body.number, 'ringGroup');
    await assertDestinationExists(db, body.noAnswerDestination);
    await assertMembers(db, memberIds);
    let created: Row;
    try {
      created = await db.transaction(async (tx) => {
        const [g] = (await tx.insert(ringGroups).values(body).returning()) as [Row];
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
      entityType: 'ring_group',
      entityId: created.id,
      summary: `Created ring group ${created.number} (${created.name})`,
      diff: { after: { ...body, memberIds } },
    });
    app.generator.requestApply('api-change');
    return reply.code(201).send(await toDto(db, created));
  });

  app.patch('/api/ring-groups/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { memberIds, ...body } = RingGroupUpdateSchema.parse(req.body);
    const before = await getGroup(id);
    if (body.number && body.number !== before.number)
      await assertNumberAvailable(db, body.number, 'ringGroup', id);
    if (body.noAnswerDestination) {
      if (body.noAnswerDestination.type === 'ring_group' && body.noAnswerDestination.id === id)
        throw badRequest("A ring group can't send unanswered calls to itself");
      await assertDestinationExists(db, body.noAnswerDestination);
    }
    if (memberIds) await assertMembers(db, memberIds);
    let after: Row;
    try {
      after = await db.transaction(async (tx) => {
        const [g] = Object.keys(body).length
          ? ((await tx.update(ringGroups).set(body).where(eq(ringGroups.id, id)).returning()) as [
              Row,
            ])
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
      entityType: 'ring_group',
      entityId: id,
      summary: `Updated ring group ${after.number} (${after.name})`,
      diff: { after: { ...body, ...(memberIds ? { memberIds } : {}) } },
    });
    app.generator.requestApply('api-change');
    return toDto(db, after);
  });

  app.delete('/api/ring-groups/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const g = await getGroup(id);
    const usedBy = await findReferences(db, 'ring_group', id);
    if (usedBy.length)
      throw conflict(`Ring group ${g.name} is still used by ${usedBy.join(', ')}`, { usedBy });
    await db.delete(ringGroups).where(eq(ringGroups.id, id));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'ring_group',
      entityId: id,
      summary: `Deleted ring group ${g.number} (${g.name})`,
      diff: { before: g },
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });
}
