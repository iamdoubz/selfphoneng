// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/blocked-numbers (04 §7.3): PostgreSQL, then AstDB SP/BLOCK/<number>, which every trunk
// entry checks (03 §6.4). Admin only.
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BlockedCreateSchema,
  formatNumber,
  type BlockedDto,
  type ListResponse,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import { blockedNumbers } from '../db/schema.ts';
import { conflict, notFound } from '../errors.ts';
import { setBlock } from '../services/astdb.ts';
import { audit } from '../services/audit.ts';

type Row = typeof blockedNumbers.$inferSelect;
const toDto = (b: Row): BlockedDto => ({
  id: b.id,
  number: b.number,
  reason: b.reason,
  createdAt: b.createdAt.toISOString(),
});
const IdParams = z.object({ id: z.uuid() });
const isUniqueViolation = (e: unknown) =>
  ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === '23505';

export async function blockedRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);
  // Offline Asterisk catches up from PostgreSQL on its next connect (04 §5.5).
  const mirror = async (number: string, on: boolean) => {
    if (app.ami.isConnected()) await setBlock(app.ami, number, on);
  };

  app.get('/api/blocked-numbers', async (): Promise<ListResponse<BlockedDto>> => ({
    items: (await db.select().from(blockedNumbers).orderBy(desc(blockedNumbers.createdAt))).map(
      toDto,
    ),
    nextCursor: null,
  }));

  app.post('/api/blocked-numbers', async (req, reply) => {
    const body = BlockedCreateSchema.parse(req.body);
    let b: Row;
    try {
      [b] = (await db.insert(blockedNumbers).values(body).returning()) as [Row];
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`${formatNumber(body.number)} is already blocked`);
      throw e;
    }
    await mirror(b.number, true);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'blocked_number',
      entityId: b.id,
      summary: `Blocked ${formatNumber(b.number)}${b.reason ? ` (${b.reason})` : ''}`,
    });
    return reply.code(201).send(toDto(b));
  });

  app.delete('/api/blocked-numbers/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const [b] = await db.delete(blockedNumbers).where(eq(blockedNumbers.id, id)).returning();
    if (!b) throw notFound('Not blocked');
    await mirror(b.number, false);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'blocked_number',
      entityId: id,
      summary: `Unblocked ${formatNumber(b.number)}`,
    });
    return { ok: true };
  });
}
