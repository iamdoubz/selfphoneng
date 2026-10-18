// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/me/voicemail and /api/me/greetings (04 §5.6, §7.3): the signed-in user's own mailbox.
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GREETINGS, type ListResponse, type VoicemailDto } from '@selfphoneng/shared';
import { requireAuth } from '../auth/guards.ts';
import { extensions, voicemailMessages } from '../db/schema.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { AudioError, MAX_UPLOAD_BYTES, toPcmWav } from '../media/audio.ts';
import { toVoicemailDto, type watchVoicemail } from '../services/voicemail.ts';

declare module 'fastify' {
  interface FastifyInstance {
    voicemail: ReturnType<typeof watchVoicemail>;
  }
}

const IdParams = z.object({ id: z.uuid() });
const KindParams = z.object({ kind: z.enum(GREETINGS) });
const MoveBody = z.object({ folder: z.enum(['INBOX', 'Old']) });

export async function meRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAuth);
  // Greetings arrive as the raw request body (a recorded Blob or a picked File), any audio type.
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_r, b, done) =>
    done(null, b),
  );

  async function myExtension(userId: string) {
    const [ext] = await db
      .select({ id: extensions.id, number: extensions.number })
      .from(extensions)
      .where(eq(extensions.userId, userId));
    if (!ext) throw notFound("You don't have an extension yet. Ask your admin.");
    return ext;
  }

  async function myMessage(userId: string, id: string) {
    const ext = await myExtension(userId);
    const [row] = await db
      .select()
      .from(voicemailMessages)
      .where(
        and(
          eq(voicemailMessages.id, id),
          eq(voicemailMessages.extensionId, ext.id),
          isNull(voicemailMessages.deletedAt),
        ),
      );
    if (!row) throw notFound('Message not found');
    return { ext, row };
  }

  /** VoicemailMove/Remove renumber the folder and update MWI (04 §5.6); then re-read the box. */
  async function mailboxAction(fields: Record<string, string>, ext: string) {
    if (!app.ami.isConnected())
      throw new HttpError(503, 'unavailable', 'Asterisk is not connected');
    await app.ami.action({ Context: 'default', Mailbox: ext, ...fields });
    await app.voicemail.scan(ext);
  }

  app.get('/api/me/voicemail', async (req): Promise<ListResponse<VoicemailDto>> => {
    const ext = await myExtension(req.user!.id);
    const rows = await db
      .select()
      .from(voicemailMessages)
      .where(and(eq(voicemailMessages.extensionId, ext.id), isNull(voicemailMessages.deletedAt)))
      .orderBy(desc(voicemailMessages.receivedAt));
    return { items: rows.map(toVoicemailDto), nextCursor: null };
  });

  app.get('/api/me/voicemail/:id/audio', async (req, reply) => {
    const { row } = await myMessage(req.user!.id, IdParams.parse(req.params).id);
    if ((req.query as { download?: string }).download)
      reply.header(
        'content-disposition',
        `attachment; filename="voicemail-${row.receivedAt.toISOString().slice(0, 16).replace(/[T:]/g, '-')}.wav"`,
      );
    return reply.sendFile(row.filePath, app.voicemail.spoolDir); // handles Range
  });

  app.patch('/api/me/voicemail/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { folder } = MoveBody.parse(req.body);
    const { ext, row } = await myMessage(req.user!.id, id);
    if (row.folder !== folder)
      await mailboxAction(
        { Action: 'VoicemailMove', Folder: row.folder, ID: row.msgId, ToFolder: folder },
        ext.number,
      );
    return toVoicemailDto((await myMessage(req.user!.id, id)).row);
  });

  app.delete('/api/me/voicemail/:id', async (req) => {
    const { ext, row } = await myMessage(req.user!.id, IdParams.parse(req.params).id);
    await mailboxAction(
      { Action: 'VoicemailRemove', Folder: row.folder, ID: row.msgId },
      ext.number,
    );
    return { ok: true };
  });

  const greetingPath = (ext: string, kind: string) =>
    join(app.voicemail.spoolDir, 'default', ext, `${kind}.wav`);

  app.get('/api/me/greetings', async (req) => {
    const ext = await myExtension(req.user!.id);
    return Object.fromEntries(GREETINGS.map((k) => [k, existsSync(greetingPath(ext.number, k))]));
  });

  app.get('/api/me/greetings/:kind/audio', async (req, reply) => {
    const { kind } = KindParams.parse(req.params);
    const ext = await myExtension(req.user!.id);
    if (!existsSync(greetingPath(ext.number, kind))) throw notFound('No greeting recorded');
    return reply.sendFile(`default/${ext.number}/${kind}.wav`, app.voicemail.spoolDir);
  });

  app.put('/api/me/greetings/:kind', async (req) => {
    const { kind } = KindParams.parse(req.params);
    const ext = await myExtension(req.user!.id);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      throw badRequest('Send the audio file');
    const out = greetingPath(ext.number, kind);
    await mkdir(join(out, '..'), { recursive: true });
    try {
      await toPcmWav(req.body, out);
    } catch (e) {
      if (!(e instanceof AudioError)) throw e;
      req.log.info({ err: e.message }, 'greeting conversion failed');
      throw badRequest("That file isn't audio we can read");
    }
    return { ok: true };
  });

  app.delete('/api/me/greetings/:kind', async (req) => {
    const { kind } = KindParams.parse(req.params);
    const ext = await myExtension(req.user!.id);
    await rm(greetingPath(ext.number, kind), { force: true });
    return { ok: true };
  });
}
