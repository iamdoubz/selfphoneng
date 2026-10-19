// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/settings (04 §7.3) and the dashboard warnings. Admin only.
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SettingsSchemas,
  SmtpInputSchema,
  type Destination,
  type SettingKey,
  type SettingsDto,
  type Warning,
} from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { dids, extensions, trunks } from '../db/schema.ts';
import { HttpError, badRequest } from '../errors.ts';
import { requireAdmin } from '../auth/guards.ts';
import { encrypt } from '../crypto/secrets.ts';
import { audit } from '../services/audit.ts';
import { assertDestinationExists } from '../services/destinations.ts';
import { getAllSettings, getSetting, setSetting } from '../services/settings.ts';
import { notifyEmergency } from '../services/emergency.ts';
import { readTlsCert } from '../services/tls.ts';
import type { SendMail } from '../services/mail.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** Decorated by the caller (index.ts: SMTP; tests: a fake). */
    sendMail: SendMail;
  }
}

/** Set by the system itself, never through PATCH. */
const READ_ONLY = new Set<string>([
  'system.restartRequired',
  'system.transportHash',
  'sms.webhookToken',
  'setup.completed',
]);

async function toDto(db: Db): Promise<SettingsDto> {
  const { smtp, ...rest } = await getAllSettings(db);
  return {
    ...rest,
    smtp: smtp && {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      username: smtp.username,
      from: smtp.from,
      hasPassword: smtp.passwordEnc !== '',
    },
  };
}

/** References inside settings must point at rows that exist; transports in use stay on. */
async function checkRefs(db: Db, v: Record<string, unknown>) {
  for (const key of ['routing.defaultCallerIdDidId', 'emergency.defaultCallerIdDidId'] as const) {
    const id = v[key] as string | null | undefined;
    if (!id) continue;
    const [d] = await db.select({ id: dids.id }).from(dids).where(eq(dids.id, id));
    if (!d) throw badRequest(`${key}: that phone number does not exist`);
  }
  const ids = v['emergency.notifyExtensionIds'] as string[] | undefined;
  if (ids?.length) {
    const found = await db
      .select({ id: extensions.id })
      .from(extensions)
      .where(inArray(extensions.id, ids));
    if (found.length !== new Set(ids).size)
      throw badRequest('emergency.notifyExtensionIds: one of those extensions does not exist');
  }
  if (v['routing.unmatchedDidDestination'])
    await assertDestinationExists(db, v['routing.unmatchedDidDestination'] as Destination);
  for (const [key, transport] of [
    ['sip.tcpEnabled', 'tcp'],
    ['sip.tlsEnabled', 'tls'],
  ] as const)
    if (v[key] === false) {
      const [t] = await db
        .select({ name: trunks.name })
        .from(trunks)
        .where(eq(trunks.transport, transport));
      if (t) throw badRequest(`Trunk ${t.name} uses ${transport.toUpperCase()}: change it first`);
    }
}

export async function settingsRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  app.get('/api/settings', () => toDto(db));

  app.patch('/api/settings', async (req) => {
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    const values: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(body)) {
      if (!(key in SettingsSchemas) || READ_ONLY.has(key))
        throw badRequest(`${key} can't be changed here`);
      if (key === 'smtp') {
        // The password is write-only: empty keeps the stored one.
        const input = SmtpInputSchema.nullable().parse(raw);
        const old = await getSetting(db, 'smtp');
        values.smtp = input && {
          host: input.host,
          port: input.port,
          secure: input.secure,
          username: input.username,
          from: input.from,
          passwordEnc: input.password ? encrypt(input.password) : (old?.passwordEnc ?? ''),
        };
      } else values[key] = SettingsSchemas[key as SettingKey].parse(raw);
    }
    await checkRefs(db, values);
    const before = await getAllSettings(db);
    if (values['sip.tlsEnabled'] === true && !before['sip.tlsEnabled']) {
      const cert = await readTlsCert(app.config.TLS_DIR);
      if (!cert.ok) throw badRequest(`Can't turn on TLS. ${cert.error}`);
    }
    for (const [key, value] of Object.entries(values))
      await setSetting(db, key as SettingKey, value as never);
    const changed = Object.keys(values).filter(
      (k) => JSON.stringify(before[k as keyof typeof before]) !== JSON.stringify(values[k]),
    );
    if (changed.length) {
      await audit(db, {
        actorUserId: req.user!.id,
        actorIp: req.ip,
        action: 'update',
        entityType: 'settings',
        summary: `Changed settings: ${changed.join(', ')}`,
        diff: {
          before: Object.fromEntries(changed.map((k) => [k, before[k as keyof typeof before]])),
          after: Object.fromEntries(changed.map((k) => [k, values[k]])),
        },
      });
      app.generator.requestApply('api-change');
    }
    return toDto(db);
  });

  app.post('/api/settings/smtp/test', async (req) => {
    const { to } = z.object({ to: z.email() }).parse(req.body);
    try {
      await app.sendMail({
        to: [to],
        subject: 'SelfPhoneNG test email',
        text: 'Email from your phone system works.',
      });
    } catch (e) {
      throw badRequest(`Sending failed: ${(e as Error).message}`);
    }
    return { ok: true };
  });

  /** Settings → Emergency → Test notifications (06 §6.5): email + ring-out, never dials 911. */
  app.post('/api/settings/emergency/test', async (req) => {
    const [ext] = await db.select().from(extensions).where(eq(extensions.userId, req.user!.id));
    const notified = await notifyEmergency(
      { db, ami: app.ami, live: app.live, send: app.sendMail, log: req.log },
      {
        ext: ext?.number ?? '',
        name: req.user!.displayName,
        callerId: 'TEST',
        dialed: '911',
        test: true,
      },
    );
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'emergency_test',
      summary: 'Tested the emergency notifications (nothing was dialed)',
      diff: { after: notified },
    });
    return { notified };
  });

  /** The server's public IPv4, as an outside service sees it (only sent when asked). */
  app.post('/api/settings/network/detect-public-ip', async () => {
    for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
      const ip = await fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((r) => (r.ok ? r.text() : ''))
        .catch(() => '');
      if (z.ipv4().safeParse(ip.trim()).success) return { ip: ip.trim() };
    }
    throw new HttpError(502, 'unavailable', "Couldn't detect the public IP. Enter it by hand.");
  });

  // First-run wizard (05 §2.1).
  app.get('/api/setup/status', async () => ({
    completed: await getSetting(db, 'setup.completed'),
  }));
  app.post('/api/setup/complete', async (req) => {
    await setSetting(db, 'setup.completed', true);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'setup_complete',
      summary: 'Finished the setup wizard',
    });
    return { ok: true };
  });

  /** The SIP TLS certificate, for Settings → Security (M11-T2). */
  app.get('/api/system/tls', () => readTlsCert(app.config.TLS_DIR));

  /** Things an admin should fix, for the dashboard banner (05 §2). */
  app.get('/api/system/warnings', async (): Promise<{ items: Warning[] }> => {
    const items: Warning[] = [];
    const s = await getAllSettings(db);
    if (s['system.restartRequired'])
      items.push({
        code: 'restart_required',
        message: 'SIP port or transport changes need a telephony restart.',
        link: '/admin/system',
      });
    const [anyTrunk] = await db.select({ id: trunks.id }).from(trunks).limit(1);
    const e911 = s['emergency.defaultCallerIdDidId'];
    if (anyTrunk && !e911)
      items.push({
        code: 'e911_cid_missing',
        message: 'No emergency (E911) caller ID is set. 911 calls may not carry your address.',
        link: '/admin/settings/emergency',
      });
    if (e911) {
      const [d] = await db.select().from(dids).where(eq(dids.id, e911));
      if (d && !d.e911Address)
        items.push({
          code: 'e911_address_unconfirmed',
          message: 'Confirm the emergency caller ID number has an E911 address at voip.ms.',
          link: '/admin/numbers',
        });
    }
    if (s['sip.tlsEnabled']) {
      const cert = await readTlsCert(app.config.TLS_DIR);
      const days = cert.ok ? (Date.parse(cert.notAfter) - Date.now()) / 86_400_000 : 0;
      if (days < 14)
        items.push({
          code: 'tls_cert',
          message: cert.ok
            ? `The SIP TLS certificate ${days < 0 ? 'has expired' : `expires in ${Math.ceil(days)} days`}. Run scripts/tls-cert.sh after renewing it.`
            : `SIP over TLS is on, but: ${cert.error}.`,
          link: '/admin/settings/security',
        });
    }
    if (!s.smtp)
      items.push({
        code: 'smtp_missing',
        message: 'Email is not set up, so emergency and voicemail emails can’t be sent.',
        link: '/admin/settings/email',
      });
    return { items };
  });
}
