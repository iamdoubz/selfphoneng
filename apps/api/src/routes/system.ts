// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/system/* (04 §7.3). Admin only.
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/guards.ts';
import { audit } from '../services/audit.ts';
import { getSetting } from '../services/settings.ts';
import { HttpError } from '../errors.ts';
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

  // ponytail: the M3 subset of 04 §7.3's status (the wizard needs the LAN IP); M11 adds the rest.
  app.get('/api/system/status', async () => ({
    ami: { connected: app.ami.isConnected() },
    restartRequired: await getSetting(app.db, 'system.restartRequired'),
    // With host networking (production) these are the server's own addresses.
    lanIps: Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i!.address),
  }));

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

  app.get('/api/system/generated-files', async () => ({
    files: await Promise.all(
      GENERATED_FILES.map(async (name) => ({
        name,
        content: maskSecrets(await readFile(join(app.generator.dir, name), 'utf8').catch(() => '')),
      })),
    ),
  }));
}
