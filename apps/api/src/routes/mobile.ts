// SPDX-License-Identifier: AGPL-3.0-or-later
// Pairing the mobile app (13 §2, §4): a one-time code from My settings, traded by the app for a
// device token; the person's paired phones, and removing one.
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  MobilePairSchema,
  type ListResponse,
  type MobileDeviceDto,
  type MobilePairCode,
  type MobilePairResult,
} from '@selfphoneng/shared';
import { PAIR_CODE_TTL_MS, generatePairCode, pairDevice } from '../auth/devices.ts';
import { SLOW, requireAuth } from '../auth/guards.ts';
import { hashToken } from '../auth/tokens.ts';
import { mobileDevices } from '../db/schema.ts';
import { forbidden, HttpError, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';

const IdParams = z.object({ id: z.uuid() });

export async function mobileRoutes(app: FastifyInstance) {
  const db = app.db;
  const act = (req: FastifyRequest) => ({ actorUserId: req.user!.id, actorIp: req.ip });

  app.post(
    '/api/me/mobile-devices/pair',
    { preHandler: requireAuth, config: SLOW },
    async (req): Promise<MobilePairCode> => {
      // Only a person at the web page: no token (a stolen phone can't make itself a spare).
      if (!req.sessionId) throw forbidden('Pair a phone from the web page');
      const userId = req.user!.id;
      await db
        .delete(mobileDevices)
        .where(and(eq(mobileDevices.userId, userId), isNull(mobileDevices.tokenHash)));
      const code = generatePairCode();
      const expiresAt = new Date(Date.now() + PAIR_CODE_TTL_MS);
      const [d] = await db
        .insert(mobileDevices)
        .values({ userId, pairCodeHash: hashToken(code), pairExpiresAt: expiresAt })
        .returning({ id: mobileDevices.id });
      await audit(db, {
        ...act(req),
        action: 'create',
        entityType: 'mobile_device',
        entityId: d!.id,
        summary: 'Made a code to pair a phone',
      });
      const server = `https://${app.config.PUBLIC_HOSTNAME}`;
      const link = `selfphoneng://pair?${new URLSearchParams({ server, code })}`;
      return {
        code,
        server,
        link,
        qr: await QRCode.toDataURL(link, { margin: 2, width: 280 }),
        expiresAt: expiresAt.toISOString(),
      };
    },
  );

  /** Public: the code is the credential. The only time the device token is shown. */
  app.post('/api/mobile/pair', { config: SLOW }, async (req): Promise<MobilePairResult> => {
    const { code, ...device } = MobilePairSchema.parse(req.body);
    const paired = await pairDevice(db, code, device);
    if (!paired)
      throw new HttpError(
        404,
        'pair_code_invalid',
        'That code is wrong or expired. Make a new one.',
      );
    await audit(db, {
      actorUserId: paired.user.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'mobile_device',
      entityId: paired.deviceId,
      summary: `Paired ${device.platform} phone ${device.name}`,
    });
    return {
      token: paired.token,
      user: { name: paired.user.displayName, email: paired.user.email },
    };
  });

  app.get(
    '/api/me/mobile-devices',
    { preHandler: requireAuth },
    async (req): Promise<ListResponse<MobileDeviceDto>> => {
      const rows = await db
        .select()
        .from(mobileDevices)
        .where(and(eq(mobileDevices.userId, req.user!.id), isNotNull(mobileDevices.tokenHash)))
        .orderBy(mobileDevices.createdAt);
      return {
        items: rows.map((d) => ({
          id: d.id,
          name: d.name!,
          platform: d.platform as MobileDeviceDto['platform'],
          tokenPrefix: d.tokenPrefix!,
          createdAt: d.createdAt.toISOString(),
          lastUsedAt: d.lastUsedAt?.toISOString() ?? null,
          current: d.id === req.mobileDeviceId,
        })),
        nextCursor: null,
      };
    },
  );

  /** Removes one of my phones; the app's Sign out removes itself. */
  app.delete('/api/me/mobile-devices/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const [d] = await db
      .delete(mobileDevices)
      .where(and(eq(mobileDevices.id, id), eq(mobileDevices.userId, req.user!.id)))
      .returning();
    if (!d) throw notFound('Phone not found');
    await audit(db, {
      ...act(req),
      action: 'delete',
      entityType: 'mobile_device',
      entityId: id,
      summary: `Removed phone ${d.name ?? '(not paired)'}`,
    });
    return { ok: true };
  });
}
