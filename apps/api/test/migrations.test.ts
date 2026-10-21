// SPDX-License-Identifier: AGPL-3.0-or-later
// migrationsPending (08 §3.1): the api backs up before running new migrations, not on every start.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsPending } from '../src/db/client.ts';
import { createTestDb, hasTestDb } from './db.ts';

const MIGRATIONS = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

describe.skipIf(!hasTestDb)('migrationsPending', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let newer: string;
  beforeAll(async () => {
    t = await createTestDb();
    // This image's migrations plus one the database hasn't run: a newer version.
    newer = await mkdtemp(join(tmpdir(), 'sp-mig-'));
    await cp(MIGRATIONS, newer, { recursive: true });
    const file = join(newer, 'meta', '_journal.json');
    const j = JSON.parse(await readFile(file, 'utf8'));
    j.entries.push({ ...j.entries.at(-1), idx: j.entries.length, tag: '9999_next' });
    await writeFile(file, JSON.stringify(j));
  });
  afterAll(async () => {
    await t?.drop();
    await rm(newer, { recursive: true, force: true });
  });

  it('none when up to date, counts when the image has more, none for an empty database', async () => {
    expect(await migrationsPending(t.db)).toBeNull();
    const pending = await migrationsPending(t.db, newer);
    expect(pending).toEqual({ applied: pending!.total - 1, total: pending!.total });
    await t.db.execute(sql`drop schema drizzle cascade`);
    expect(await migrationsPending(t.db, newer)).toBeNull();
  });
});
