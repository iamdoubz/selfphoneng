// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/conferences (04 §7.3): conference rooms. PINs are stored encrypted; admins read them back
// because they hand them out. Admin only.
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ConferenceCreateSchema,
  ConferenceUpdateSchema,
  conferencePinsMakeSense,
  type ConferenceDto,
  type ListResponse,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import { decrypt, encrypt } from '../crypto/secrets.ts';
import { conferences } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';
import { findReferences } from '../services/destinations.ts';
import { assertNumberAvailable } from '../services/numbering.ts';

type Row = typeof conferences.$inferSelect;

const toDto = (c: Row): ConferenceDto => ({
  id: c.id,
  number: c.number,
  name: c.name,
  pin: c.pinEnc ? decrypt(c.pinEnc) : null,
  adminPin: c.adminPinEnc ? decrypt(c.adminPinEnc) : null,
  maxMembers: c.maxMembers,
  record: c.record,
  createdAt: c.createdAt.toISOString(),
});

/** PIN fields → encrypted columns (undefined = leave as is). */
function columns<T extends { pin?: string | null; adminPin?: string | null }>(body: T) {
  const { pin, adminPin, ...rest } = body;
  const enc = (v: string | null | undefined) =>
    v === undefined ? undefined : v === null ? null : encrypt(v);
  return { ...rest, pinEnc: enc(pin), adminPinEnc: enc(adminPin) };
}

/** For the audit log: whether PINs changed, never their values. */
const redact = (body: z.output<typeof ConferenceUpdateSchema>) => ({
  ...body,
  ...(body.pin !== undefined ? { pin: body.pin ? 'set' : 'none' } : {}),
  ...(body.adminPin !== undefined ? { adminPin: body.adminPin ? 'set' : 'none' } : {}),
});

const IdParams = z.object({ id: z.uuid() });
const isUniqueViolation = (e: unknown) =>
  ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === '23505';

export async function conferenceRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  async function getRoom(id: string) {
    const [c] = await db.select().from(conferences).where(eq(conferences.id, id));
    if (!c) throw notFound('Conference room not found');
    return c;
  }

  app.get('/api/conferences', async (): Promise<ListResponse<ConferenceDto>> => {
    const rows = await db.select().from(conferences).orderBy(asc(conferences.number));
    return { items: rows.map(toDto), nextCursor: null };
  });

  app.get('/api/conferences/:id', async (req) =>
    toDto(await getRoom(IdParams.parse(req.params).id)),
  );

  app.post('/api/conferences', async (req, reply) => {
    const body = ConferenceCreateSchema.parse(req.body);
    await assertNumberAvailable(db, body.number, 'conference');
    let created: Row;
    try {
      [created] = (await db.insert(conferences).values(columns(body)).returning()) as [Row];
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`${body.number} is already taken`);
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'conference',
      entityId: created.id,
      summary: `Created conference room ${created.number} (${created.name})`,
      diff: { after: redact(body) },
    });
    app.generator.requestApply('api-change');
    return reply.code(201).send(toDto(created));
  });

  app.patch('/api/conferences/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = ConferenceUpdateSchema.parse(req.body);
    const before = toDto(await getRoom(id));
    if (!conferencePinsMakeSense({ ...before, ...body }))
      throw badRequest('An admin PIN needs a (different) room PIN');
    if (body.number && body.number !== before.number)
      await assertNumberAvailable(db, body.number, 'conference', id);
    let after: Row;
    try {
      [after] = (await db
        .update(conferences)
        .set(columns(body))
        .where(eq(conferences.id, id))
        .returning()) as [Row];
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`${body.number} is already taken`);
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'conference',
      entityId: id,
      summary: `Updated conference room ${after.number} (${after.name})`,
      diff: { after: redact(body) },
    });
    app.generator.requestApply('api-change');
    return toDto(after);
  });

  app.delete('/api/conferences/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const c = await getRoom(id);
    const usedBy = await findReferences(db, 'conference', id);
    if (usedBy.length)
      throw conflict(`Conference room ${c.name} is still used by ${usedBy.join(', ')}`, {
        usedBy,
      });
    await db.delete(conferences).where(eq(conferences.id, id));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'conference',
      entityId: id,
      summary: `Deleted conference room ${c.number} (${c.name})`,
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });
}
