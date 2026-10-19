// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/queues (04 §7.3): agents are sent as `members: [{extensionId, penalty}]`. Admin only.
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  QueueCreateSchema,
  QueueUpdateSchema,
  type Destination,
  type ListResponse,
  type QueueDto,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import type { Db } from '../db/client.ts';
import { extensions, queueMembers, queueMemberState, queues } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';
import {
  assertDestinationExists,
  describeDestination,
  findReferences,
} from '../services/destinations.ts';
import { assertNumberAvailable } from '../services/numbering.ts';
import { setPaused } from '../services/queues.ts';
import { queueStats, StatsQuery } from '../services/queuestats.ts';

type Row = typeof queues.$inferSelect;
type Member = { extensionId: string; penalty: number };
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function membersOf(db: Db, id: string) {
  return db
    .select({
      extensionId: queueMembers.extensionId,
      penalty: queueMembers.penalty,
      paused: queueMemberState.paused,
    })
    .from(queueMembers)
    .innerJoin(extensions, eq(extensions.id, queueMembers.extensionId))
    .leftJoin(
      queueMemberState,
      and(
        eq(queueMemberState.queueId, queueMembers.queueId),
        eq(queueMemberState.extensionId, queueMembers.extensionId),
      ),
    )
    .where(eq(queueMembers.queueId, id))
    .orderBy(asc(extensions.number));
}

async function toDto(db: Db, q: Row): Promise<QueueDto> {
  const timeoutDestination = q.timeoutDestination as Destination;
  const { createdAt, updatedAt: _u, ...rest } = q;
  return {
    ...rest,
    members: (await membersOf(db, q.id)).map((m) => ({ ...m, paused: m.paused ?? false })),
    timeoutDestination,
    timeoutSummary: await describeDestination(db, timeoutDestination),
    createdAt: createdAt.toISOString(),
  };
}

const IdParams = z.object({ id: z.uuid() });
const MemberParams = z.object({ id: z.uuid(), extId: z.uuid() });

async function assertMembers(db: Db, ms: Member[]) {
  if (!ms.length) return;
  const ids = ms.map((m) => m.extensionId);
  const found = await db
    .select({ id: extensions.id })
    .from(extensions)
    .where(inArray(extensions.id, ids));
  if (found.length !== ids.length) throw badRequest('One of the agents no longer exists');
}

/** Replaces the agent list; removed agents lose their pause state. */
async function setMembers(db: Db | Tx, id: string, ms: Member[]) {
  await db.delete(queueMembers).where(eq(queueMembers.queueId, id));
  if (ms.length) await db.insert(queueMembers).values(ms.map((m) => ({ queueId: id, ...m })));
  const kept = ms.map((m) => m.extensionId);
  await db
    .delete(queueMemberState)
    .where(
      and(
        eq(queueMemberState.queueId, id),
        kept.length ? notInArray(queueMemberState.extensionId, kept) : undefined,
      ),
    );
}

const isUniqueViolation = (e: unknown) =>
  ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === '23505';

export async function queueRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  async function getQueue(id: string) {
    const [q] = await db.select().from(queues).where(eq(queues.id, id));
    if (!q) throw notFound('Queue not found');
    return q;
  }

  app.get('/api/queues', async (): Promise<ListResponse<QueueDto>> => {
    const rows = await db.select().from(queues).orderBy(asc(queues.number));
    return { items: await Promise.all(rows.map((q) => toDto(db, q))), nextCursor: null };
  });

  app.get('/api/queues/:id', async (req) =>
    toDto(db, await getQueue(IdParams.parse(req.params).id)),
  );

  app.post('/api/queues', async (req, reply) => {
    const { members = [], ...body } = QueueCreateSchema.parse(req.body);
    await assertNumberAvailable(db, body.number, 'queue');
    await assertDestinationExists(db, body.timeoutDestination);
    await assertMembers(db, members);
    let created: Row;
    try {
      created = await db.transaction(async (tx) => {
        const [q] = (await tx.insert(queues).values(body).returning()) as [Row];
        await setMembers(tx, q.id, members);
        return q;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`${body.number} is already taken`);
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'queue',
      entityId: created.id,
      summary: `Created queue ${created.number} (${created.name})`,
      diff: { after: { ...body, members } },
    });
    app.generator.requestApply('api-change');
    return reply.code(201).send(await toDto(db, created));
  });

  app.patch('/api/queues/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { members, ...body } = QueueUpdateSchema.parse(req.body);
    const before = await getQueue(id);
    if (body.number && body.number !== before.number)
      await assertNumberAvailable(db, body.number, 'queue', id);
    if (body.timeoutDestination) {
      if (body.timeoutDestination.type === 'queue' && body.timeoutDestination.id === id)
        throw badRequest("A queue can't send callers who waited too long back to itself");
      await assertDestinationExists(db, body.timeoutDestination);
    }
    if (members) await assertMembers(db, members);
    let after: Row;
    try {
      after = await db.transaction(async (tx) => {
        const [q] = Object.keys(body).length
          ? ((await tx.update(queues).set(body).where(eq(queues.id, id)).returning()) as [Row])
          : [before];
        if (members) await setMembers(tx, id, members);
        return q;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`${body.number} is already taken`);
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'queue',
      entityId: id,
      summary: `Updated queue ${after.number} (${after.name})`,
      diff: { after: { ...body, ...(members ? { members } : {}) } },
    });
    app.generator.requestApply('api-change');
    return toDto(db, after);
  });

  app.delete('/api/queues/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const q = await getQueue(id);
    const usedBy = await findReferences(db, 'queue', id);
    if (usedBy.length)
      throw conflict(`Queue ${q.name} is still used by ${usedBy.join(', ')}`, { usedBy });
    await db.delete(queues).where(eq(queues.id, id));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'queue',
      entityId: id,
      summary: `Deleted queue ${q.number} (${q.name})`,
      diff: { before: q },
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });

  for (const action of ['pause', 'unpause'] as const)
    app.post(`/api/queues/:id/members/:extId/${action}`, async (req) => {
      const { id, extId } = MemberParams.parse(req.params);
      const q = await getQueue(id);
      const [m] = await db
        .select({ id: extensions.id, number: extensions.number })
        .from(queueMembers)
        .innerJoin(extensions, eq(extensions.id, queueMembers.extensionId))
        .where(and(eq(queueMembers.queueId, id), eq(queueMembers.extensionId, extId)));
      if (!m) throw notFound(`That extension isn't an agent of queue ${q.number}`);
      await setPaused(db, app.ami, q, m, action === 'pause');
      await audit(db, {
        actorUserId: req.user!.id,
        actorIp: req.ip,
        action: `queue_${action}`,
        entityType: 'queue',
        entityId: id,
        summary: `${action === 'pause' ? 'Paused' : 'Unpaused'} ${m.number} in queue ${q.number}`,
      });
      return { ok: true };
    });

  app.get('/api/queues/:id/stats', async (req) => {
    const q = await getQueue(IdParams.parse(req.params).id);
    return queueStats(db, q, StatsQuery.parse(req.query));
  });
}
