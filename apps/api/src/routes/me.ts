// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/me (settings, call report), /api/me/voicemail and /api/me/greetings (04 §5.6, §7.3).
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ContrackOptionsSchema,
  GREETINGS,
  MeUpdateSchema,
  type ListResponse,
  type MeDto,
  type VoicemailDto,
  type SoftphoneQr,
  type WebRtcCreds,
} from '@selfphoneng/shared';
import { softphoneQr } from '../provisioning/linphone.ts';
import { decrypt, encrypt, isTrivialPin } from '../crypto/secrets.ts';
import { setDnd, setForward } from '../services/astdb.ts';
import { audit } from '../services/audit.ts';
import { checkForward, FORWARD_KINDS, type ForwardKind } from '../services/forwards.ts';
import { getSetting } from '../services/settings.ts';
import { requireAuth } from '../auth/guards.ts';
import {
  extensions,
  queueMembers,
  queues,
  userRuntimeState,
  users,
  voicemailMessages,
} from '../db/schema.ts';
import {
  contrackBook,
  contrackCheck,
  contrackSettings,
  forgetBook,
  tokenFor,
} from '../contacts/contrack.ts';
import { setPaused } from '../services/queues.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
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
/** Anything a person would type: "(312) 555-1234", "+44 20 …", "172". */
const ClickToCallBody = z.object({
  number: z
    .string()
    .max(40)
    .regex(/^[0-9*#+()\s.-]*[0-9*#][0-9*#+()\s.-]*$/, 'Enter a number'),
});

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

  /** The browser softphone's identity: <ext>-web, same SIP password as the desk phone (03 §5.2). */
  async function myState(userId: string): Promise<MeDto> {
    const [row] = await db
      .select({ e: extensions, s: userRuntimeState })
      .from(extensions)
      .leftJoin(userRuntimeState, eq(userRuntimeState.extensionId, extensions.id))
      .where(eq(extensions.userId, userId));
    if (!row) throw notFound("You don't have an extension yet. Ask your admin.");
    const { e, s } = row;
    return {
      extension: { number: e.number, name: e.name },
      dnd: s?.dnd ?? false,
      cfu: s?.cfu ?? null,
      cfb: s?.cfb ?? null,
      cfna: s?.cfna ?? null,
      voicemailEnabled: e.voicemailEnabled,
      voicemailEmail: e.voicemailEmail,
      voicemailAttachAudio: e.voicemailAttachAudio,
      voicemailDeleteAfterEmail: e.voicemailDeleteAfterEmail,
      callReport: e.callReport,
      callReportTime: e.callReportTime,
      callReportWeekday: e.callReportWeekday,
      callReportSummaries: e.callReportSummaries,
      contrack: await myContrack(userId),
    };
  }

  /** Contrack mode: is my token set, and does it work (11 §4.3). Null in builtin mode. */
  async function myContrack(userId: string): Promise<MeDto['contrack']> {
    const c = await contrackSettings(db);
    if (!c) return null;
    const token = await tokenFor(db, c, userId);
    const book = token ? await contrackBook(db, c, userId) : null;
    const [u] = await db
      .select({ logCalls: users.contrackLogCalls, logSummaries: users.contrackLogSummaries })
      .from(users)
      .where(eq(users.id, userId));
    return {
      connected: !!book && !book.error,
      tokenPrefix: token ? `${token.slice(0, 12)}…` : null,
      publicUrl: c.publicUrl,
      logCalls: u?.logCalls ?? true,
      logSummaries: u?.logSummaries ?? false,
      summariesAvailable:
        (await getSetting(db, 'ai.callTranscripts')) && (await getSetting(db, 'ai.callSummaries')),
    };
  }

  /** Connect my Contrack account: the token must read my contacts before it's kept. */
  app.put('/api/me/contrack', async (req) => {
    const { token } = z.object({ token: z.string().trim().min(8).max(200) }).parse(req.body);
    const c = await contrackSettings(db);
    if (!c) throw conflict('Contacts are not in Contrack (Settings → Contacts)');
    await contrackCheck(c.url, token).catch((err: Error) => {
      throw badRequest(err.message);
    });
    // Calls are logged from now on, not the ones before (11 §4.4).
    await db
      .update(users)
      .set({
        contrackTokenEnc: encrypt(token),
        contrackLogSince: sql`coalesce(${users.contrackLogSince}, now())`,
      })
      .where(eq(users.id, req.user!.id));
    forgetBook(req.user!.id);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'user',
      entityId: req.user!.id,
      summary: 'Connected their Contrack account',
    });
    return myState(req.user!.id);
  });

  /** Log my calls in Contrack, with or without their summaries (11 §4.4). */
  app.patch('/api/me/contrack', async (req) => {
    const o = ContrackOptionsSchema.parse(req.body);
    const [u] = await db
      .select({ logCalls: users.contrackLogCalls })
      .from(users)
      .where(eq(users.id, req.user!.id));
    await db
      .update(users)
      .set({
        ...(o.logCalls !== undefined ? { contrackLogCalls: o.logCalls } : {}),
        ...(o.logSummaries !== undefined ? { contrackLogSummaries: o.logSummaries } : {}),
        // Turned back on: from now, not the calls while it was off.
        ...(o.logCalls && !u?.logCalls ? { contrackLogSince: new Date() } : {}),
      })
      .where(eq(users.id, req.user!.id));
    return myState(req.user!.id);
  });

  app.delete('/api/me/contrack', async (req) => {
    await db.update(users).set({ contrackTokenEnc: null }).where(eq(users.id, req.user!.id));
    forgetBook(req.user!.id);
    return myState(req.user!.id);
  });

  app.get('/api/me', async (req) => myState(req.user!.id));

  // Queue login from Home (05 §4, 04 §7.3), the same as *45<queue> on a phone.
  for (const action of ['pause', 'unpause'] as const)
    app.post(`/api/me/queues/:id/${action}`, async (req) => {
      const { id } = IdParams.parse(req.params);
      const ext = await myExtension(req.user!.id);
      const [q] = await db
        .select({ id: queues.id, number: queues.number })
        .from(queueMembers)
        .innerJoin(queues, eq(queues.id, queueMembers.queueId))
        .where(and(eq(queueMembers.queueId, id), eq(queueMembers.extensionId, ext.id)));
      if (!q) throw notFound("You aren't an agent of that queue");
      await setPaused(db, app.ami, q, ext, action === 'pause');
      return { ok: true };
    });

  /** DND, forwards and voicemail options: PostgreSQL first, then AstDB (04 §5.5). */
  app.patch('/api/me', async (req) => {
    const body = MeUpdateSchema.parse(req.body);
    const ext = await myExtension(req.user!.id);
    const runtime: { dnd?: boolean } & Partial<Record<ForwardKind, string | null>> = {};
    if (body.dnd !== undefined) runtime.dnd = body.dnd;
    for (const k of FORWARD_KINDS) {
      const v = body[k];
      if (v !== undefined) runtime[k] = v ? await checkForward(db, ext, v) : null;
    }
    if (body.voicemailPin && isTrivialPin(body.voicemailPin, ext.number))
      throw badRequest('That PIN is too easy to guess (repeated, sequential or your extension)');
    const { dnd: _d, cfu: _u, cfb: _b, cfna: _n, voicemailPin, ...vm } = body;
    // A new call report schedule starts with its next period, not one that just ended.
    const rescheduled =
      body.callReport !== undefined ||
      body.callReportTime !== undefined ||
      body.callReportWeekday !== undefined;
    await db.transaction(async (tx) => {
      if (Object.keys(runtime).length)
        await tx
          .insert(userRuntimeState)
          .values({ extensionId: ext.id, ...runtime })
          .onConflictDoUpdate({ target: userRuntimeState.extensionId, set: runtime });
      if (Object.keys(vm).length || voicemailPin)
        await tx
          .update(extensions)
          .set({
            ...vm,
            ...(voicemailPin ? { voicemailPinEnc: encrypt(voicemailPin) } : {}),
            ...(rescheduled ? { callReportSentAt: new Date() } : {}),
          })
          .where(eq(extensions.id, ext.id));
    });
    // Offline Asterisk catches up from PostgreSQL on its next connect.
    if (app.ami.isConnected()) {
      if (runtime.dnd !== undefined) await setDnd(app.ami, ext.number, runtime.dnd);
      for (const k of FORWARD_KINDS)
        if (runtime[k] !== undefined) await setForward(app.ami, k, ext.number, runtime[k]);
    }
    if (runtime.dnd !== undefined) await app.live.loadFromDb();
    if (voicemailPin) app.generator.requestApply('api-change');
    const changed = Object.keys(body).map((k) => (k === 'voicemailPin' ? 'voicemail PIN' : k));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'extension',
      entityId: ext.id,
      summary: `${ext.number} changed their own ${changed.join(', ')}`,
      diff: { after: { ...runtime, ...vm } },
    });
    return myState(req.user!.id);
  });

  /** "Set up a phone app" (07 §5): a Linphone setup QR for my own extension. */
  app.get('/api/me/softphone-qr', async (req): Promise<SoftphoneQr> => {
    const [ext] = await db.select().from(extensions).where(eq(extensions.userId, req.user!.id));
    if (!ext) throw notFound("You don't have an extension yet. Ask your admin.");
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'reveal_sip_credentials',
      entityType: 'extension',
      entityId: ext.id,
      summary: `Made a phone app setup QR for extension ${ext.number}`,
    });
    return softphoneQr(app.config.APP_SECRET, app.config.PUBLIC_HOSTNAME, ext.id);
  });

  app.get('/api/me/webrtc', async (req): Promise<WebRtcCreds> => {
    const [ext] = await db.select().from(extensions).where(eq(extensions.userId, req.user!.id));
    if (!ext) throw notFound("You don't have an extension yet. Ask your admin.");
    if (!ext.webrtcEnabled)
      throw notFound('The browser softphone is turned off for your extension');
    const host = app.config.PUBLIC_HOSTNAME;
    const stun = await getSetting(db, 'network.stunServer');
    const turn = await getSetting(db, 'network.turn');
    return {
      wsUrl: app.config.WEBRTC_WS_URL ?? `wss://${host}/ws`,
      sipUri: `sip:${ext.number}-web@${host}`,
      authUser: `${ext.number}-web`,
      password: decrypt(ext.sipPasswordEnc),
      displayName: ext.name,
      iceServers: [
        ...(stun ? [{ urls: `stun:${stun}` }] : []),
        ...(turn
          ? [{ urls: turn.url, username: turn.username, credential: decrypt(turn.credentialEnc) }]
          : []),
      ],
    };
  });

  /** Rings the user's desk phone first; when they pick up, it dials `number` (04 §7.3). */
  app.post('/api/me/click-to-call', async (req) => {
    const { number } = ClickToCallBody.parse(req.body);
    const ext = await myExtension(req.user!.id);
    if (!app.ami.isConnected())
      throw new HttpError(503, 'unavailable', 'Asterisk is not connected');
    if (!app.live.deskOnline(ext.number))
      throw conflict("Your desk phone isn't connected, so it can't ring");
    const target = number.replace(/[^0-9*#+]/g, '');
    await app.ami.action({
      Action: 'Originate',
      Channel: `PJSIP/${ext.number}`,
      Context: 'sp-from-ext',
      Exten: target,
      Priority: '1',
      CallerID: `"${target}" <${ext.number}>`,
      Async: 'true',
    });
    return { ok: true };
  });

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
