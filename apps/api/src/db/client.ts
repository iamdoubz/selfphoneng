// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.ts';

// Next to this file in src/ and in the image (the Dockerfile copies them to dist/db/migrations).
const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export function createDb(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

/**
 * This image has migrations the database hasn't run yet. False for an empty database (a fresh
 * install: nothing to lose). Reads drizzle's own bookkeeping, `drizzle.__drizzle_migrations`.
 */
export async function migrationsPending(db: Db, folder = MIGRATIONS_DIR): Promise<boolean> {
  const journal = JSON.parse(await readFile(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  const t = await db.execute<{ t: string | null }>(
    sql`select to_regclass('drizzle.__drizzle_migrations')::text as t`,
  );
  if (!t.rows[0]?.t) return false;
  const r = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
  );
  return r.rows[0]!.n < journal.entries.length;
}
