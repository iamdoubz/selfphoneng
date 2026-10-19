// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/extensions and /api/numbering (04 §7.2, §7.3). Admin only.
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ExtensionCreateSchema,
  ExtensionUpdateSchema,
  NUMBER_KINDS,
  type ExtensionDto,
  type ListResponse,
  type SipCredentials,
  type SoftphoneQr,
} from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { extensions, userRuntimeState } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { requireAdmin } from '../auth/guards.ts';
import {
  decrypt,
  encrypt,
  generatePin,
  generateSipPassword,
  isTrivialPin,
} from '../crypto/secrets.ts';
import { audit } from '../services/audit.ts';
import { assertNumberAvailable, nextFreeNumber } from '../services/numbering.ts';
import { assertMohClass } from './moh.ts';
import { softphoneQr } from '../provisioning/linphone.ts';
import { findReferences } from '../services/destinations.ts';
import { getSetting } from '../services/settings.ts';

type ExtRow = typeof extensions.$inferSelect;

export const toExtensionDto = (e: ExtRow): ExtensionDto => ({
  id: e.id,
  number: e.number,
  userId: e.userId,
  name: e.name,
  webrtcEnabled: e.webrtcEnabled,
  maxContacts: e.maxContacts,
  ringSeconds: e.ringSeconds,
  voicemailEnabled: e.voicemailEnabled,
  voicemailEmail: e.voicemailEmail,
  voicemailAttachAudio: e.voicemailAttachAudio,
  voicemailDeleteAfterEmail: e.voicemailDeleteAfterEmail,
  outboundClass: e.outboundClass,
  outboundCallerIdDidId: e.outboundCallerIdDidId,
  emergencyCallerIdDidId: e.emergencyCallerIdDidId,
  emergencyLocation: e.emergencyLocation,
  recordMode: e.recordMode,
  pickupGroup: e.pickupGroup,
  language: e.language,
  mohClass: e.mohClass,
  blfNumbers: e.blfNumbers,
  createdAt: e.createdAt.toISOString(),
});

const IdParams = z.object({ id: z.uuid() });

const isUniqueViolation = (e: unknown, constraint?: string) => {
  const err =
    (e as { cause?: { code?: string; constraint?: string } }).cause ??
    (e as { code?: string; constraint?: string });
  return err?.code === '23505' && (!constraint || err.constraint?.includes(constraint));
};

function checkPin(pin: string, number: string) {
  if (isTrivialPin(pin, number))
    throw badRequest(
      'That PIN is too easy to guess (repeated, sequential or the extension number)',
    );
}

/** extensions.user_id is unique: one extension per user. */
async function assertUserFree(db: Db, userId: string | null | undefined, excludeId?: string) {
  if (!userId) return;
  const [e] = await db
    .select({ id: extensions.id, number: extensions.number })
    .from(extensions)
    .where(eq(extensions.userId, userId));
  if (e && e.id !== excludeId) throw conflict(`That user already has extension ${e.number}`);
}

async function getExt(db: Db, id: string): Promise<ExtRow> {
  const [e] = await db.select().from(extensions).where(eq(extensions.id, id));
  if (!e) throw notFound('Extension not found');
  return e;
}

export async function extensionRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  app.get('/api/numbering/next', async (req) => {
    const { kind } = z.object({ kind: z.enum(NUMBER_KINDS) }).parse(req.query);
    return { number: await nextFreeNumber(db, kind) };
  });

  // ponytail: one page with every extension (v1 targets ≤100); cursor paging when needed.
  app.get('/api/extensions', async (): Promise<ListResponse<ExtensionDto>> => {
    const rows = await db.select().from(extensions).orderBy(asc(extensions.number));
    return { items: rows.map(toExtensionDto), nextCursor: null };
  });

  app.get('/api/extensions/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return toExtensionDto(await getExt(db, id));
  });

  app.post('/api/extensions', async (req, reply) => {
    const { voicemailPin, ...body } = ExtensionCreateSchema.parse(req.body);
    await assertNumberAvailable(db, body.number, 'user');
    await assertUserFree(db, body.userId);
    await assertMohClass(db, body.mohClass);
    if (voicemailPin) checkPin(voicemailPin, body.number);
    let created: ExtRow;
    try {
      created = await db.transaction(async (tx) => {
        const [e] = await tx
          .insert(extensions)
          .values({
            ...body,
            sipPasswordEnc: encrypt(generateSipPassword()),
            voicemailPinEnc: encrypt(voicemailPin ?? generatePin()),
          })
          .returning();
        await tx.insert(userRuntimeState).values({ extensionId: e!.id });
        return e!;
      });
    } catch (e) {
      if (isUniqueViolation(e, 'user_id')) throw conflict('That user already has an extension');
      if (isUniqueViolation(e)) throw conflict(`${body.number} is already taken`);
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'extension',
      entityId: created.id,
      summary: `Created extension ${created.number} (${created.name})`,
      diff: { after: body },
    });
    app.generator.requestApply('api-change');
    return reply.code(201).send(toExtensionDto(created));
  });

  app.patch('/api/extensions/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { voicemailPin, ...body } = ExtensionUpdateSchema.parse(req.body);
    const before = await getExt(db, id);
    if (body.number && body.number !== before.number)
      await assertNumberAvailable(db, body.number, 'user', id);
    await assertUserFree(db, body.userId, id);
    await assertMohClass(db, body.mohClass);
    if (voicemailPin) checkPin(voicemailPin, body.number ?? before.number);
    let after: ExtRow;
    try {
      [after] = (await db
        .update(extensions)
        .set({ ...body, ...(voicemailPin ? { voicemailPinEnc: encrypt(voicemailPin) } : {}) })
        .where(eq(extensions.id, id))
        .returning()) as [ExtRow];
    } catch (e) {
      if (isUniqueViolation(e, 'user_id')) throw conflict('That user already has an extension');
      throw e;
    }
    const changed = (Object.keys(body) as (keyof typeof body)[]).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'extension',
      entityId: id,
      summary: `Updated extension ${after.number}${voicemailPin ? ' (voicemail PIN changed)' : ''}${changed.length ? ` (${changed.join(', ')})` : ''}`,
      diff: {
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, after[k]])),
      },
    });
    app.generator.requestApply('api-change');
    return toExtensionDto(after);
  });

  app.delete('/api/extensions/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const e = await getExt(db, id);
    const usedBy = await findReferences(db, 'user', id);
    if (usedBy.length)
      throw conflict(`Extension ${e.number} is still used by ${usedBy.join(', ')}`, { usedBy });
    await db.delete(extensions).where(eq(extensions.id, id)); // members, runtime state, devices cascade
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'extension',
      entityId: id,
      summary: `Deleted extension ${e.number} (${e.name})`,
      diff: { before: toExtensionDto(e) },
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });

  app.post('/api/extensions/:id/regenerate-sip-password', async (req) => {
    const { id } = IdParams.parse(req.params);
    const e = await getExt(db, id);
    await db
      .update(extensions)
      .set({ sipPasswordEnc: encrypt(generateSipPassword()) })
      .where(eq(extensions.id, id));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'regenerate_sip_password',
      entityType: 'extension',
      entityId: id,
      summary: `New SIP password for extension ${e.number}; its phones must be updated`,
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });

  // Reveal (05 §1): only on an explicit click, and every reveal is audited.
  app.get('/api/extensions/:id/sip-credentials', async (req): Promise<SipCredentials> => {
    const { id } = IdParams.parse(req.params);
    const e = await getExt(db, id);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'reveal_sip_credentials',
      entityType: 'extension',
      entityId: id,
      summary: `Viewed the SIP password of extension ${e.number}`,
    });
    return {
      server: app.config.PUBLIC_HOSTNAME,
      port: await getSetting(db, 'sip.udpPort'),
      transport: 'udp',
      username: e.number,
      password: decrypt(e.sipPasswordEnc),
      webUsername: e.webrtcEnabled ? `${e.number}-web` : null,
    };
  });

  /** Linphone setup QR (07 §5). It carries the SIP password, so it's audited like a reveal. */
  app.get('/api/extensions/:id/softphone-qr', async (req): Promise<SoftphoneQr> => {
    const { id } = IdParams.parse(req.params);
    const e = await getExt(db, id);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'reveal_sip_credentials',
      entityType: 'extension',
      entityId: id,
      summary: `Made a phone app setup QR for extension ${e.number}`,
    });
    return softphoneQr(app.config.APP_SECRET, app.config.PUBLIC_HOSTNAME, id);
  });
}
