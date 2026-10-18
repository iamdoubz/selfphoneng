// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/recordings (04 §7.3, 08): call recordings, only ever served through these authenticated
// routes. Admins see all; a user may play the recordings of calls they took part in.
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ListResponse, RecordingDto } from '@selfphoneng/shared';
import { requireAdmin, requireAuth } from '../auth/guards.ts';
import type { Db } from '../db/client.ts';
import { callExtensions, calls, extensions, recordings } from '../db/schema.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';

const IdParams = z.object({ id: z.uuid() });
const ListQuery = z.object({ cursor: z.string().max(100).optional() });

/** Deletes recordings older than `days` (file and row); 0 keeps them forever (04 §8). */
export async function cleanupRecordings(db: Db, dir: string, days: number): Promise<number> {
  if (days <= 0) return 0;
  const old = await db
    .select({ id: recordings.id, filePath: recordings.filePath })
    .from(recordings)
    .where(lt(recordings.startedAt, sql`now() - make_interval(days => ${days})`));
  for (const r of old) await rm(join(dir, r.filePath), { force: true });
  if (old.length)
    await db.delete(recordings).where(
      inArray(
        recordings.id,
        old.map((r) => r.id),
      ),
    );
  return old.length;
}

export async function recordingRoutes(app: FastifyInstance) {
  const { db } = app;
  const dir = resolve(app.config.RECORDINGS_DIR);

  async function getRecording(id: string) {
    const [r] = await db.select().from(recordings).where(eq(recordings.id, id));
    if (!r) throw notFound('Recording not found');
    return r;
  }

  app.get(
    '/api/recordings',
    { preHandler: requireAdmin },
    async (req): Promise<ListResponse<RecordingDto>> => {
      const { cursor } = ListQuery.parse(req.query);
      const before = cursor ? new Date(Buffer.from(cursor, 'base64url').toString()) : null;
      if (before && Number.isNaN(before.getTime())) throw badRequest('Bad cursor');
      const rows = await db
        .select({ r: recordings, c: calls })
        .from(recordings)
        .leftJoin(calls, eq(calls.recordingId, recordings.id))
        .where(before ? lt(recordings.startedAt, before) : undefined)
        .orderBy(desc(recordings.startedAt))
        .limit(51);
      const items = rows.slice(0, 50);
      return {
        items: items.map(({ r, c }) => ({
          id: r.id,
          startedAt: r.startedAt.toISOString(),
          durationMs: r.durationMs,
          sizeBytes: r.sizeBytes,
          call: c
            ? {
                id: c.id,
                direction: c.direction,
                fromNumber: c.fromNumber,
                fromName: c.fromName,
                toNumber: c.toNumber,
              }
            : null,
        })),
        nextCursor:
          rows.length > 50
            ? Buffer.from(items.at(-1)!.r.startedAt.toISOString()).toString('base64url')
            : null,
      };
    },
  );

  app.get('/api/recordings/:id/audio', { preHandler: requireAuth }, async (req, reply) => {
    const r = await getRecording(IdParams.parse(req.params).id);
    if (req.user!.role !== 'admin') {
      // Only a participant: their extension is on the call this recording belongs to.
      const [mine] = await db
        .select({ id: calls.id })
        .from(calls)
        .innerJoin(callExtensions, eq(callExtensions.callId, calls.id))
        .innerJoin(extensions, eq(extensions.id, callExtensions.extensionId))
        .where(and(eq(calls.recordingId, r.id), eq(extensions.userId, req.user!.id)))
        .limit(1);
      if (!mine) throw forbidden('Not your call');
    }
    if ((req.query as { download?: string }).download)
      reply.header(
        'content-disposition',
        `attachment; filename="recording-${r.startedAt.toISOString().slice(0, 16).replace(/[T:]/g, '-')}.wav"`,
      );
    return reply.sendFile(r.filePath, dir); // handles Range
  });

  app.delete('/api/recordings/:id', { preHandler: requireAdmin }, async (req) => {
    const r = await getRecording(IdParams.parse(req.params).id);
    await rm(join(dir, r.filePath), { force: true });
    await db.delete(recordings).where(eq(recordings.id, r.id)); // calls.recording_id → null
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'recording',
      entityId: r.id,
      summary: `Deleted the recording of a call on ${r.startedAt.toISOString().slice(0, 10)}`,
    });
    return { ok: true };
  });
}
