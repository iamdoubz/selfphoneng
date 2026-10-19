// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/devices (04 §7.3, 07 §1): desk phones. The provisioning password (20 chars) is made here,
// stored encrypted, and shown to admins: they type it into the phone. Admin only.
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DeviceCreateSchema,
  DeviceUpdateSchema,
  type DeviceDto,
  type ListResponse,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import { decrypt, encrypt, randomAlnum } from '../crypto/secrets.ts';
import type { Db } from '../db/client.ts';
import { devices, extensions } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { loadContext, provisioningUrl } from '../provisioning/context.ts';
import { grandstream } from '../provisioning/templates/grandstream.ts';
import { yealink } from '../provisioning/templates/yealink.ts';
import { audit } from '../services/audit.ts';

type Row = typeof devices.$inferSelect;
type Ext = { number: string; name: string };

const IdParams = z.object({ id: z.uuid() });
const isUniqueViolation = (e: unknown) =>
  ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === '23505';
const fmtMac = (m: string) => m.match(/../g)!.join(':');

export async function deviceRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  const toDto = (d: Row, e: Ext): DeviceDto => ({
    id: d.id,
    mac: d.mac,
    vendor: d.vendor as DeviceDto['vendor'],
    model: d.model,
    label: d.label,
    extensionId: d.extensionId,
    extensionNumber: e.number,
    extensionName: e.name,
    provisioningUrl: provisioningUrl(app.config),
    provisioningPassword: decrypt(d.provisioningPasswordEnc),
    lastProvisionedAt: d.lastProvisionedAt?.toISOString() ?? null,
    lastProvisionedIp: d.lastProvisionedIp,
    createdAt: d.createdAt.toISOString(),
  });

  async function getDevice(id: string) {
    const [r] = await db
      .select({ d: devices, e: { number: extensions.number, name: extensions.name } })
      .from(devices)
      .innerJoin(extensions, eq(extensions.id, devices.extensionId))
      .where(eq(devices.id, id));
    if (!r) throw notFound('Phone not found');
    return r;
  }
  async function getExt(dbx: Db, id: string): Promise<Ext> {
    const [e] = await dbx
      .select({ number: extensions.number, name: extensions.name })
      .from(extensions)
      .where(eq(extensions.id, id));
    if (!e) throw badRequest('That user no longer exists');
    return e;
  }

  app.get('/api/devices', async (): Promise<ListResponse<DeviceDto>> => {
    const rows = await db
      .select({ d: devices, e: { number: extensions.number, name: extensions.name } })
      .from(devices)
      .innerJoin(extensions, eq(extensions.id, devices.extensionId))
      .orderBy(asc(extensions.number), asc(devices.mac));
    return { items: rows.map((r) => toDto(r.d, r.e)), nextCursor: null };
  });

  app.get('/api/devices/:id', async (req) => {
    const r = await getDevice(IdParams.parse(req.params).id);
    return toDto(r.d, r.e);
  });

  app.post('/api/devices', async (req, reply) => {
    const body = DeviceCreateSchema.parse(req.body);
    const e = await getExt(db, body.extensionId);
    let d: Row;
    try {
      [d] = (await db
        .insert(devices)
        .values({ ...body, provisioningPasswordEnc: encrypt(randomAlnum(20)) })
        .returning()) as [Row];
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`${fmtMac(body.mac)} is already added`);
      throw err;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'device',
      entityId: d.id,
      summary: `Added ${body.vendor} phone ${fmtMac(d.mac)} for ${e.number} (${e.name})`,
      diff: { after: body },
    });
    return reply.code(201).send(toDto(d, e));
  });

  app.patch('/api/devices/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = DeviceUpdateSchema.parse(req.body);
    await getDevice(id);
    const e = body.extensionId ? await getExt(db, body.extensionId) : null;
    let d: Row;
    try {
      [d] = (await db.update(devices).set(body).where(eq(devices.id, id)).returning()) as [Row];
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`${fmtMac(body.mac!)} is already added`);
      throw err;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'device',
      entityId: id,
      summary: `Updated phone ${fmtMac(d.mac)}`,
      diff: { after: body },
    });
    return toDto(d, e ?? (await getDevice(id)).e);
  });

  app.delete('/api/devices/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { d } = await getDevice(id);
    await db.delete(devices).where(eq(devices.id, id));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'device',
      entityId: id,
      summary: `Removed phone ${fmtMac(d.mac)}`,
    });
    return { ok: true };
  });

  /** The file the phone would get, passwords masked (04 §7.3). */
  app.get('/api/devices/:id/config-preview', async (req) => {
    const { d } = await getDevice(IdParams.parse(req.params).id);
    const render =
      d.vendor === 'yealink' ? yealink : d.vendor === 'grandstream' ? grandstream : null;
    if (!render) throw badRequest('Nothing is served to this kind of phone: set it up by hand');
    const { ctx } = (await loadContext(db, app.config, d.mac))!;
    // Both secrets wherever they appear (the phonebook URL carries the provisioning password).
    const content = render(ctx)
      .replaceAll(ctx.ext.sipPassword, '********')
      .replaceAll(ctx.provPassword, '********');
    return {
      file: d.vendor === 'yealink' ? `${d.mac}.cfg` : `cfg${d.mac}.xml`,
      content,
      /** The company time zone isn't in the phone table: phones show UTC. */
      timezoneWarning: !ctx.timezone.supported,
    };
  });
}
