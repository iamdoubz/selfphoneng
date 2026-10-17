// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/system/* (04 §7.3). Admin only.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/guards.ts';
import { audit } from '../services/audit.ts';
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

  app.get('/api/system/generated-files', async () => ({
    files: await Promise.all(
      GENERATED_FILES.map(async (name) => ({
        name,
        content: maskSecrets(await readFile(join(app.generator.dir, name), 'utf8').catch(() => '')),
      })),
    ),
  }));
}
