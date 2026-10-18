// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/sounds: recorded prompts (04 §6, §7.3). Admin only. Files live in SOUNDS_DIR as
// <id>.wav (8 kHz) and <id>.g722 (HD); dialplan plays them as custom/<id>.
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { asc, eq, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SOUND_MAX_BYTES,
  SoundName,
  SoundUpdateSchema,
  type ListResponse,
  type SoundDto,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import type { Db } from '../db/client.ts';
import { announcements, ivrs, soundFiles } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { AudioError, toPrompt } from '../media/audio.ts';
import { audit } from '../services/audit.ts';
import { getSetting } from '../services/settings.ts';

type SoundRow = typeof soundFiles.$inferSelect;

const toDto = (s: SoundRow): SoundDto => ({
  id: s.id,
  name: s.name,
  asteriskName: s.asteriskName,
  durationMs: s.durationMs,
  originalFilename: s.originalFilename,
  createdAt: s.createdAt.toISOString(),
});

const IdParams = z.object({ id: z.uuid() });
const UploadQuery = z.object({ name: SoundName, filename: z.string().max(200).optional() });

/** Everything that plays this sound, for the 409 on delete. */
export async function soundReferences(db: Db, id: string): Promise<string[]> {
  const ivrRows = await db
    .select({ n: ivrs.name })
    .from(ivrs)
    .where(or(eq(ivrs.greetingSoundId, id), eq(ivrs.invalidSoundId, id)));
  const annRows = await db
    .select({ n: announcements.name })
    .from(announcements)
    .where(eq(announcements.soundId, id));
  return [
    ...ivrRows.map((r) => `digital receptionist ${r.n}`),
    ...annRows.map((r) => `announcement ${r.n}`),
    ...((await getSetting(db, 'recordings.announcementSoundId')) === id
      ? ['the call recording notice (Settings → Recording)']
      : []),
  ];
}

export async function soundRoutes(app: FastifyInstance) {
  const { db } = app;
  const dir = resolve(app.config.SOUNDS_DIR);
  app.addHook('preHandler', requireAdmin);
  // The audio file is the raw request body (a File from the page), any audio type.
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: SOUND_MAX_BYTES }, (_r, b, done) =>
    done(null, b),
  );

  async function getSound(id: string) {
    const [s] = await db.select().from(soundFiles).where(eq(soundFiles.id, id));
    if (!s || s.kind !== 'prompt') throw notFound('Sound not found');
    return s;
  }

  app.get('/api/sounds', async (): Promise<ListResponse<SoundDto>> => {
    const rows = await db
      .select()
      .from(soundFiles)
      .where(eq(soundFiles.kind, 'prompt'))
      .orderBy(asc(soundFiles.name));
    return { items: rows.map(toDto), nextCursor: null };
  });

  app.get('/api/sounds/:id', async (req) => toDto(await getSound(IdParams.parse(req.params).id)));

  app.get('/api/sounds/:id/audio', async (req, reply) => {
    const s = await getSound(IdParams.parse(req.params).id);
    return reply.sendFile(`${s.id}.wav`, dir);
  });

  /** POST /api/sounds?name=Main greeting&filename=greeting.mp3, body = the file. */
  app.post('/api/sounds', async (req, reply) => {
    const { name, filename } = UploadQuery.parse(req.query);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      throw badRequest('Send the audio file');
    const id = randomUUID();
    await mkdir(dir, { recursive: true });
    let durationMs: number;
    try {
      durationMs = await toPrompt(req.body, resolve(dir, id));
    } catch (e) {
      if (!(e instanceof AudioError)) throw e;
      req.log.info({ err: e.message }, 'sound conversion failed');
      throw badRequest("That file isn't audio we can read");
    }
    const [row] = (await db
      .insert(soundFiles)
      .values({
        id,
        name,
        kind: 'prompt',
        source: 'upload',
        originalFilename: filename ?? null,
        asteriskName: `custom/${id}`,
        durationMs,
      })
      .returning()) as [SoundRow];
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'sound',
      entityId: id,
      summary: `Uploaded sound "${name}"`,
    });
    return reply.code(201).send(toDto(row));
  });

  app.patch('/api/sounds/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { name } = SoundUpdateSchema.parse(req.body);
    const before = await getSound(id);
    const [after] = (await db
      .update(soundFiles)
      .set({ name })
      .where(eq(soundFiles.id, id))
      .returning()) as [SoundRow];
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'sound',
      entityId: id,
      summary: `Renamed sound "${before.name}" to "${name}"`,
    });
    return toDto(after);
  });

  app.delete('/api/sounds/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const s = await getSound(id);
    const usedBy = await soundReferences(db, id);
    if (usedBy.length)
      throw conflict(`"${s.name}" is still used by ${usedBy.join(', ')}`, { usedBy });
    await db.delete(soundFiles).where(eq(soundFiles.id, id));
    await rm(resolve(dir, `${id}.wav`), { force: true });
    await rm(resolve(dir, `${id}.g722`), { force: true });
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'sound',
      entityId: id,
      summary: `Deleted sound "${s.name}"`,
    });
    return { ok: true };
  });
}
