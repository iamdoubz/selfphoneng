// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/system/* (04 §7.3). Admin only.
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { desc, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { ListResponse, SystemEventDto, SystemStatus } from '@selfphoneng/shared';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/guards.ts';
import { audit } from '../services/audit.ts';
import { getAllSettings } from '../services/settings.ts';
import { systemEvents } from '../db/schema.ts';
import { appVersion } from './about.ts';
import { csvCell } from './calls.ts';
import { BACKUP_NAME, listBackups, runBackup } from '../services/backup.ts';
import { HttpError, notFound } from '../errors.ts';
import { AmiDisconnectedError } from '../ami/client.ts';
import { GENERATED_FILES } from '../generator/index.ts';

/** Generated files hold plaintext SIP passwords and PINs: mask them in the debug view. */
export function maskSecrets(conf: string): string {
  return conf
    .replace(/^(\s*(?:password|secret)\s*=\s*).+$/gim, '$1********')
    .replace(/^(\s*\d+\s*=>\s*)[^,\n]*/gm, '$1********'); // voicemail.conf: "101 => PIN,Name,..."
}

export async function systemRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  app.post('/api/system/config/apply', async (req) => {
    const r = await app.generator.apply({ trigger: 'manual', force: true });
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'config_apply',
      summary: `Applied Asterisk config (${r.ok ? 'ok' : r.error})`,
    });
    return r;
  });

  app.post('/api/system/config/rollback', async (req) => {
    const r = await app.generator.rollback();
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'config_rollback',
      summary: `Rolled back Asterisk config (${r.ok ? 'ok' : r.error})`,
    });
    return r;
  });

  app.get('/api/system/status', async (): Promise<SystemStatus> => {
    const s = await getAllSettings(app.db);
    return {
      version: await appVersion(),
      hostname: app.config.PUBLIC_HOSTNAME,
      companyName: s['general.companyName'],
      publicIp: s['network.publicIp'],
      publicIpDynamic: s['network.publicIpWatch'],
      // With host networking (production) these are the server's own addresses.
      lanIps: Object.values(networkInterfaces())
        .flat()
        .filter((i) => i && i.family === 'IPv4' && !i.internal)
        .map((i) => i!.address),
      ports: {
        sip: s['sip.udpPort'],
        sipTcp: s['sip.tcpEnabled'],
        sips: s['sip.tlsEnabled'] ? s['sip.tlsPort'] : null,
        rtp: '10000–20000', // asterisk/conf/rtp.conf
        https: 443,
      },
      ami: { connected: app.ami.isConnected() },
      restartRequired: s['system.restartRequired'],
    };
  });

  /** The event log, newest first; `before` is the last id of the previous page. */
  const EventsQuery = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });
  const toEvent = (e: typeof systemEvents.$inferSelect): SystemEventDto => ({
    id: e.id,
    createdAt: e.createdAt.toISOString(),
    severity: e.severity as SystemEventDto['severity'],
    code: e.code,
    source: e.source,
    message: e.message,
  });
  app.get('/api/system/events', async (req): Promise<ListResponse<SystemEventDto>> => {
    const q = EventsQuery.parse(req.query);
    const rows = await app.db
      .select()
      .from(systemEvents)
      .where(q.before ? lt(systemEvents.id, q.before) : undefined)
      .orderBy(desc(systemEvents.id))
      .limit(q.limit + 1);
    const items = rows.slice(0, q.limit).map(toEvent);
    return { items, nextCursor: rows.length > q.limit ? String(items.at(-1)!.id) : null };
  });
  app.get('/api/system/events.csv', async (_req, reply) => {
    // ponytail: everything kept (90 days) in one file; page it if logs ever get big.
    const rows = await app.db.select().from(systemEvents).orderBy(desc(systemEvents.id));
    const out = ['time,severity,event,source,details'];
    for (const e of rows)
      out.push(
        [e.createdAt.toISOString(), e.severity, e.code, e.source, e.message].map(csvCell).join(','),
      );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="selfphoneng-events.csv"')
      .send(out.join('\r\n') + '\r\n');
  });

  /** 01 §4.3: transports only change on a restart. `now=true` drops calls; otherwise waits. */
  app.post('/api/system/asterisk/restart', async (req) => {
    const { now } = z.object({ now: z.enum(['true', 'false']).default('false') }).parse(req.query);
    if (!app.ami.isConnected())
      throw new HttpError(503, 'unavailable', 'Asterisk is not connected');
    await app.ami
      .action({
        Action: 'Command',
        Command: now === 'true' ? 'core restart now' : 'core restart gracefully',
      })
      // A restart can close AMI before the reply arrives: that's the restart working.
      .catch((e: unknown) => {
        if (!(e instanceof AmiDisconnectedError)) throw e;
      });
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'asterisk_restart',
      summary: `Restarted telephony${now === 'true' ? ' now' : ' (after active calls)'}`,
    });
    return { ok: true };
  });

  // Backups (04 §8.1). Restore is scripts/restore.sh only.
  app.get('/api/system/backups', () => listBackups(resolve(app.config.BACKUPS_DIR)));
  app.post('/api/system/backups', async (req) => {
    let b;
    try {
      b = await runBackup(app.config, app.db);
    } catch (err) {
      req.log.error({ err }, 'backup failed');
      throw new HttpError(500, 'backup_failed', `The backup failed: ${(err as Error).message}`);
    }
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'backup',
      summary: `Made backup ${b.name}`,
    });
    return b;
  });
  app.get('/api/system/backups/:name/download', async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const dir = resolve(app.config.BACKUPS_DIR);
    if (!BACKUP_NAME.test(name) || !(await listBackups(dir)).some((b) => b.name === name))
      throw notFound('Backup not found');
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return reply.sendFile(name, dir);
  });

  app.get('/api/system/generated-files', async () => ({
    files: await Promise.all(
      GENERATED_FILES.map(async (name) => ({
        name,
        content: maskSecrets(await readFile(join(app.generator.dir, name), 'utf8').catch(() => '')),
      })),
    ),
  }));
}
