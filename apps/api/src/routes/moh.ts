// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/moh-classes (04 §6, §7.3): music-on-hold classes and their files. A class is a folder
// MOH_DIR/<name>/ of <id>.wav (8 kHz, wav only); Asterisk plays it in random order (03 §8).
// 'default' is built in (stock opsound files) and not stored. Admin only.
// ponytail: no rename (the name is the folder and is stored on extensions and queues); delete and
// re-create instead.
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MohClassCreateSchema,
  SOUND_MAX_BYTES,
  SoundName,
  type ListResponse,
  type MohClassDto,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import type { Db } from '../db/client.ts';
import { extensions, mohClasses, queues, soundFiles } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { AudioError, durationMs, toPcmWav } from '../media/audio.ts';
import { audit } from '../services/audit.ts';

type ClassRow = typeof mohClasses.$inferSelect;

/** Throws 400 unless `name` is 'default' or a stored class. */
export async function assertMohClass(db: Db, name: string | undefined) {
  if (name === undefined || name === 'default') return;
  const [c] = await db.select().from(mohClasses).where(eq(mohClasses.name, name));
  if (!c) throw badRequest(`There is no music on hold called "${name}"`);
}

async function toDto(db: Db, c: ClassRow): Promise<MohClassDto> {
  const files = await db
    .select()
    .from(soundFiles)
    .where(eq(soundFiles.mohClassId, c.id))
    .orderBy(asc(soundFiles.name));
  return {
    id: c.id,
    name: c.name,
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      durationMs: f.durationMs,
      originalFilename: f.originalFilename,
      createdAt: f.createdAt.toISOString(),
    })),
    createdAt: c.createdAt.toISOString(),
  };
}

const IdParams = z.object({ id: z.uuid() });
const FileParams = z.object({ id: z.uuid(), fileId: z.uuid() });
const UploadQuery = z.object({ name: SoundName, filename: z.string().max(200).optional() });
const isUniqueViolation = (e: unknown) =>
  ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === '23505';

export async function mohRoutes(app: FastifyInstance) {
  const { db } = app;
  const root = resolve(app.config.MOH_DIR);
  app.addHook('preHandler', requireAdmin);
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: SOUND_MAX_BYTES }, (_r, b, done) =>
    done(null, b),
  );

  /**
   * Only a class's first file and its last one change the config (03 §8), and the generator
   * reloads only what changed: tell Asterisk to re-read the folders after every file (M8-T5).
   * ponytail: skipped while AMI is down; the next startup apply reloads MOH anyway.
   */
  async function reloadMoh() {
    if (!app.ami.isConnected()) return;
    await app.ami
      .action({ Action: 'Command', Command: 'moh reload' })
      .catch((e: unknown) => app.log.warn({ err: e }, 'moh reload'));
  }

  async function getClass(id: string) {
    const [c] = await db.select().from(mohClasses).where(eq(mohClasses.id, id));
    if (!c) throw notFound('Music on hold not found');
    return c;
  }
  async function getFile(classId: string, fileId: string) {
    const [f] = await db
      .select()
      .from(soundFiles)
      .where(and(eq(soundFiles.id, fileId), eq(soundFiles.mohClassId, classId)));
    if (!f) throw notFound('File not found');
    return f;
  }

  app.get('/api/moh-classes', async (): Promise<ListResponse<MohClassDto>> => {
    const rows = await db.select().from(mohClasses).orderBy(asc(mohClasses.name));
    return { items: await Promise.all(rows.map((c) => toDto(db, c))), nextCursor: null };
  });

  app.post('/api/moh-classes', async (req, reply) => {
    const { name } = MohClassCreateSchema.parse(req.body);
    let c: ClassRow;
    try {
      [c] = (await db.insert(mohClasses).values({ name }).returning()) as [ClassRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`"${name}" already exists`);
      throw e;
    }
    await mkdir(resolve(root, name), { recursive: true });
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'moh_class',
      entityId: c.id,
      summary: `Created music on hold "${name}"`,
    });
    return reply.code(201).send(await toDto(db, c));
  });

  app.delete('/api/moh-classes/:id', async (req) => {
    const c = await getClass(IdParams.parse(req.params).id);
    const usedBy = [
      ...(
        await db
          .select({ n: extensions.number })
          .from(extensions)
          .where(eq(extensions.mohClass, c.name))
      ).map((r) => `extension ${r.n}`),
      ...(await db.select({ n: queues.name }).from(queues).where(eq(queues.mohClass, c.name))).map(
        (r) => `queue ${r.n}`,
      ),
    ];
    if (usedBy.length)
      throw conflict(`"${c.name}" is still used by ${usedBy.join(', ')}`, { usedBy });
    await db.delete(mohClasses).where(eq(mohClasses.id, c.id)); // its sound_files cascade
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'moh_class',
      entityId: c.id,
      summary: `Deleted music on hold "${c.name}"`,
    });
    app.generator.requestApply('api-change');
    await rm(resolve(root, c.name), { recursive: true, force: true });
    return { ok: true };
  });

  /** POST /api/moh-classes/:id/files?name=Jazz&filename=jazz.mp3, body = the file. */
  app.post('/api/moh-classes/:id/files', async (req, reply) => {
    const c = await getClass(IdParams.parse(req.params).id);
    const { name, filename } = UploadQuery.parse(req.query);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      throw badRequest('Send the audio file');
    const id = randomUUID();
    const file = resolve(root, c.name, `${id}.wav`);
    await mkdir(resolve(root, c.name), { recursive: true });
    try {
      await toPcmWav(req.body, file);
    } catch (e) {
      if (!(e instanceof AudioError)) throw e;
      req.log.info({ err: e.message }, 'moh conversion failed');
      throw badRequest("That file isn't audio we can read");
    }
    await db.insert(soundFiles).values({
      id,
      name,
      kind: 'moh',
      mohClassId: c.id,
      source: 'upload',
      originalFilename: filename ?? null,
      asteriskName: `moh/${c.name}/${id}`,
      durationMs: (await durationMs(file)) ?? 0,
    });
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'sound',
      entityId: id,
      summary: `Added "${name}" to music on hold "${c.name}"`,
    });
    await reloadMoh();
    app.generator.requestApply('api-change');
    return reply.code(201).send(await toDto(db, c));
  });

  app.get('/api/moh-classes/:id/files/:fileId/audio', async (req, reply) => {
    const { id, fileId } = FileParams.parse(req.params);
    const c = await getClass(id);
    await getFile(id, fileId);
    return reply.sendFile(`${fileId}.wav`, resolve(root, c.name));
  });

  app.delete('/api/moh-classes/:id/files/:fileId', async (req) => {
    const { id, fileId } = FileParams.parse(req.params);
    const c = await getClass(id);
    const f = await getFile(id, fileId);
    await db.delete(soundFiles).where(eq(soundFiles.id, fileId));
    await rm(resolve(root, c.name, `${fileId}.wav`), { force: true });
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'sound',
      entityId: fileId,
      summary: `Removed "${f.name}" from music on hold "${c.name}"`,
    });
    await reloadMoh();
    app.generator.requestApply('api-change');
    return { ok: true };
  });
}
