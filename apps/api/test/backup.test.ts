// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T3: backup names, the APP_SECRET check restore.sh repeats in sh, listing and downloading,
// and when the daily backup is due. Making one (pg_dump + GNU tar) and restoring it run in
// scripts/e2e/m11-t3.mjs on two throwaway Docker hosts.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupDue, secretCheck, stamp } from '../src/services/backup.ts';
import { setSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe('backup names and the secret check', () => {
  it('stamps in the PBX time zone', () => {
    const t = new Date('2026-10-19T08:30:00Z');
    expect(stamp('America/Chicago', t)).toBe('20261019-0330');
    expect(stamp('Pacific/Auckland', t)).toBe('20261019-2130');
    expect(stamp('America/Chicago', new Date('2026-10-19T04:59:00Z'))).toBe('20261018-2359');
  });

  const hasSh = spawnSync('sh', ['-c', 'command -v sha256sum']).status === 0;
  it.skipIf(!hasSh)('restore.sh computes the same check from .env', () => {
    const secret = 'u2Qy9mQ8a1+gC0bq3mJ5WkQb0yq8m2c4ZtVd6pYk9h8=';
    const sh = spawnSync(
      'sh',
      ['-c', `printf 'selfphoneng-backup:%s' "$S" | sha256sum | cut -c1-16`],
      { env: { ...process.env, S: secret }, encoding: 'utf8' },
    ).stdout.trim();
    expect(sh).toBe(secretCheck(secret));
    expect(secretCheck(secret)).not.toBe(secretCheck('another'));
  });
});

describe.skipIf(!hasTestDb)('backup routes', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string) => Promise<LightMyRequestResponse>;
  const dir = () => t.app.config.BACKUPS_DIR;

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    req = (method, url) =>
      t.app.inject({ method: method as 'GET', url, headers: { ...H, cookie } });
  });
  afterAll(() => t?.close());

  it('lists backups newest first, ignoring other files', async () => {
    writeFileSync(join(dir(), 'selfphoneng-20261018-0330.tar.gz'), 'old');
    writeFileSync(join(dir(), 'selfphoneng-20261019-0330.tar.gz'), 'newer');
    // with seconds (from 2026-10-21): a second one in the same minute sorts after it, newer
    writeFileSync(join(dir(), 'selfphoneng-20261019-033045.tar.gz'), 'newest');
    writeFileSync(join(dir(), '.selfphoneng-20261020-0330.tar.gz.tmp'), 'half-written');
    writeFileSync(join(dir(), 'notes.txt'), 'x');
    const r = await req('GET', '/api/system/backups');
    expect(r.json().map((b: { name: string }) => b.name)).toEqual([
      'selfphoneng-20261019-033045.tar.gz',
      'selfphoneng-20261019-0330.tar.gz',
      'selfphoneng-20261018-0330.tar.gz',
    ]);
    expect(r.json()[1].size).toBe(5);
  });

  it('downloads one by name, nothing else', async () => {
    const r = await req('GET', '/api/system/backups/selfphoneng-20261019-0330.tar.gz/download');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="selfphoneng-20261019-0330.tar.gz"',
    );
    expect(r.body).toBe('newer');
    for (const bad of ['notes.txt', '..%2F..%2Fetc%2Fpasswd', 'selfphoneng-20261021-0330.tar.gz'])
      expect((await req('GET', `/api/system/backups/${bad}/download`)).statusCode).toBe(404);
  });

  it('is due once a day after backup.time, unless turned off', async () => {
    const at = (iso: string) => backupDue(t.app.config, t.db, new Date(iso));
    await setSetting(t.db, 'general.timezone', 'America/Chicago');
    expect(await at('2026-10-20T08:00:00Z')).toBe(false); // 03:00 there, before 03:30
    expect(await at('2026-10-20T08:31:00Z')).toBe(true);
    expect(await at('2026-10-19T08:31:00Z')).toBe(false); // that day's backup exists
    await setSetting(t.db, 'backup.enabled', false);
    expect(await at('2026-10-20T08:31:00Z')).toBe(false);
  });
});
