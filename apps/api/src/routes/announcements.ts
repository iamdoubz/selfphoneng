// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/announcements (04 §7.3): play a sound, then continue to a destination. Admin only.
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AnnouncementCreateSchema,
  AnnouncementUpdateSchema,
  type AnnouncementDto,
  type Destination,
  type ListResponse,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import type { Db } from '../db/client.ts';
import { announcements, soundFiles } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';
import {
  assertDestinationExists,
  describeDestination,
  findReferences,
} from '../services/destinations.ts';

type Row = typeof announcements.$inferSelect;

async function toDto(db: Db, a: Row): Promise<AnnouncementDto> {
  const destination = a.destination as Destination;
  const [s] = await db
    .select({ name: soundFiles.name })
    .from(soundFiles)
    .where(eq(soundFiles.id, a.soundId));
  return {
    id: a.id,
    name: a.name,
    soundId: a.soundId,
    soundName: s?.name ?? '?',
    destination,
    destinationSummary: await describeDestination(db, destination),
  };
}

const IdParams = z.object({ id: z.uuid() });

async function assertPrompt(db: Db, id: string | undefined) {
  if (!id) return;
  const [s] = await db
    .select({ kind: soundFiles.kind })
    .from(soundFiles)
    .where(eq(soundFiles.id, id));
  if (s?.kind !== 'prompt') throw badRequest('That sound no longer exists');
}

export async function announcementRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  async function getAnn(id: string) {
    const [a] = await db.select().from(announcements).where(eq(announcements.id, id));
    if (!a) throw notFound('Announcement not found');
    return a;
  }

  app.get('/api/announcements', async (): Promise<ListResponse<AnnouncementDto>> => {
    const rows = await db.select().from(announcements).orderBy(asc(announcements.name));
    return { items: await Promise.all(rows.map((a) => toDto(db, a))), nextCursor: null };
  });

  app.get('/api/announcements/:id', async (req) =>
    toDto(db, await getAnn(IdParams.parse(req.params).id)),
  );

  app.post('/api/announcements', async (req, reply) => {
    const body = AnnouncementCreateSchema.parse(req.body);
    await assertPrompt(db, body.soundId);
    await assertDestinationExists(db, body.destination);
    const [a] = (await db.insert(announcements).values(body).returning()) as [Row];
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'announcement',
      entityId: a.id,
      summary: `Created announcement ${a.name}`,
      diff: { after: body },
    });
    app.generator.requestApply('api-change');
    return reply.code(201).send(await toDto(db, a));
  });

  app.patch('/api/announcements/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = AnnouncementUpdateSchema.parse(req.body);
    await getAnn(id);
    await assertPrompt(db, body.soundId);
    if (body.destination) {
      if (body.destination.type === 'announcement' && body.destination.id === id)
        throw badRequest("An announcement can't continue to itself");
      await assertDestinationExists(db, body.destination);
    }
    const [a] = (await db
      .update(announcements)
      .set(body)
      .where(eq(announcements.id, id))
      .returning()) as [Row];
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'announcement',
      entityId: id,
      summary: `Updated announcement ${a.name}`,
      diff: { after: body },
    });
    app.generator.requestApply('api-change');
    return toDto(db, a);
  });

  app.delete('/api/announcements/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const a = await getAnn(id);
    const usedBy = await findReferences(db, 'announcement', id);
    if (usedBy.length)
      throw conflict(`${a.name} is still used by ${usedBy.join(', ')}`, { usedBy });
    await db.delete(announcements).where(eq(announcements.id, id));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'announcement',
      entityId: id,
      summary: `Deleted announcement ${a.name}`,
      diff: { before: a },
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });
}
