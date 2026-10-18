// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/ivrs (04 §7.3): digital receptionists; options are sent as `options: [{digit, destination}]`.
// Admin only.
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  IvrCreateSchema,
  IvrUpdateSchema,
  type Destination,
  type IvrDto,
  type ListResponse,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import type { Db } from '../db/client.ts';
import { ivrOptions, ivrs, soundFiles } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';
import {
  assertDestinationExists,
  describeDestination,
  findReferences,
} from '../services/destinations.ts';
import { assertNumberAvailable } from '../services/numbering.ts';

type Row = typeof ivrs.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Option = IvrDto['options'][number];

async function toDto(db: Db, r: Row): Promise<IvrDto> {
  const opts = await db
    .select()
    .from(ivrOptions)
    .where(eq(ivrOptions.ivrId, r.id))
    .orderBy(asc(ivrOptions.digit));
  return {
    id: r.id,
    number: r.number,
    name: r.name,
    greetingSoundId: r.greetingSoundId,
    invalidSoundId: r.invalidSoundId,
    timeoutSeconds: r.timeoutSeconds,
    maxRetries: r.maxRetries,
    allowDirectDial: r.allowDirectDial,
    options: await Promise.all(
      opts.map(async (o) => ({
        digit: o.digit as Option['digit'],
        destination: o.destination as Destination,
        summary: await describeDestination(db, o.destination as Destination),
      })),
    ),
    timeoutDestination: r.timeoutDestination as Destination,
    invalidDestination: r.invalidDestination as Destination,
    createdAt: r.createdAt.toISOString(),
  };
}

const IdParams = z.object({ id: z.uuid() });
const isUniqueViolation = (e: unknown) =>
  ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === '23505';

async function assertPrompt(db: Db, id: string | null | undefined) {
  if (!id) return;
  const [s] = await db
    .select({ kind: soundFiles.kind })
    .from(soundFiles)
    .where(eq(soundFiles.id, id));
  if (s?.kind !== 'prompt') throw badRequest('That sound no longer exists');
}

async function setOptions(
  db: Db | Tx,
  id: string,
  options: { digit: string; destination: Destination }[],
) {
  await db.delete(ivrOptions).where(eq(ivrOptions.ivrId, id));
  if (options.length) await db.insert(ivrOptions).values(options.map((o) => ({ ...o, ivrId: id })));
}

/** Option destinations may point at this IVR itself ("press 9 to hear this again"). */
async function assertDestinations(db: Db, ds: (Destination | undefined)[]): Promise<void> {
  for (const d of ds) if (d) await assertDestinationExists(db, d);
}

export async function ivrRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  async function getIvr(id: string) {
    const [r] = await db.select().from(ivrs).where(eq(ivrs.id, id));
    if (!r) throw notFound('Digital receptionist not found');
    return r;
  }

  app.get('/api/ivrs', async (): Promise<ListResponse<IvrDto>> => {
    const rows = await db.select().from(ivrs).orderBy(asc(ivrs.number));
    return { items: await Promise.all(rows.map((r) => toDto(db, r))), nextCursor: null };
  });

  app.get('/api/ivrs/:id', async (req) => toDto(db, await getIvr(IdParams.parse(req.params).id)));

  app.post('/api/ivrs', async (req, reply) => {
    const { options = [], ...body } = IvrCreateSchema.parse(req.body);
    await assertNumberAvailable(db, body.number, 'ivr');
    await assertPrompt(db, body.greetingSoundId);
    await assertPrompt(db, body.invalidSoundId);
    await assertDestinations(db, [
      body.timeoutDestination,
      body.invalidDestination,
      ...options.map((o) => o.destination),
    ]);
    let created: Row;
    try {
      created = await db.transaction(async (tx) => {
        const [r] = (await tx.insert(ivrs).values(body).returning()) as [Row];
        await setOptions(tx, r.id, options);
        return r;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`${body.number} is already taken`);
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'ivr',
      entityId: created.id,
      summary: `Created digital receptionist ${created.number} (${created.name})`,
      diff: { after: { ...body, options } },
    });
    app.generator.requestApply('api-change');
    return reply.code(201).send(await toDto(db, created));
  });

  app.patch('/api/ivrs/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { options, ...body } = IvrUpdateSchema.parse(req.body);
    const before = await getIvr(id);
    if (body.number && body.number !== before.number)
      await assertNumberAvailable(db, body.number, 'ivr', id);
    await assertPrompt(db, body.greetingSoundId);
    await assertPrompt(db, body.invalidSoundId);
    // Pointing at itself is fine here: the IVR exists.
    await assertDestinations(db, [
      body.timeoutDestination,
      body.invalidDestination,
      ...(options ?? []).map((o) => o.destination),
    ]);
    let after: Row;
    try {
      after = await db.transaction(async (tx) => {
        const [r] = Object.keys(body).length
          ? ((await tx.update(ivrs).set(body).where(eq(ivrs.id, id)).returning()) as [Row])
          : [before];
        if (options) await setOptions(tx, id, options);
        return r;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`${body.number} is already taken`);
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'ivr',
      entityId: id,
      summary: `Updated digital receptionist ${after.number} (${after.name})`,
      diff: { after: { ...body, ...(options ? { options } : {}) } },
    });
    app.generator.requestApply('api-change');
    return toDto(db, after);
  });

  app.delete('/api/ivrs/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const r = await getIvr(id);
    // Its own options may point back at it; those go with it, so drop them before looking.
    await db.transaction(async (tx) => {
      await tx.delete(ivrOptions).where(eq(ivrOptions.ivrId, id));
      const usedBy = await findReferences(tx, 'ivr', id);
      if (usedBy.length)
        throw conflict(`${r.name} is still used by ${usedBy.join(', ')}`, { usedBy });
      await tx.delete(ivrs).where(eq(ivrs.id, id));
    });
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'ivr',
      entityId: id,
      summary: `Deleted digital receptionist ${r.number} (${r.name})`,
      diff: { before: r },
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });
}
