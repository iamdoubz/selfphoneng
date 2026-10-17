// SPDX-License-Identifier: AGPL-3.0-or-later
// Throwaway databases for integration tests. Needs TEST_DATABASE_URL (a role that can CREATE DATABASE);
// vitest.config.ts derives it from .env when `docker compose up -d postgres` is running.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, runMigrations, type Db } from '../src/db/client.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = Boolean(TEST_DATABASE_URL);

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Creates an empty database, migrates it, and returns it with a drop() for afterAll. */
export async function createTestDb(): Promise<{ db: Db; url: string; drop: () => Promise<void> }> {
  const name = `sp_test_${randomBytes(6).toString('hex')}`;
  await admin((c) => c.query(`create database ${name}`));
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  const { db, pool } = createDb(url.toString());
  await runMigrations(db);
  return {
    db,
    url: url.toString(),
    drop: async () => {
      await pool.end();
      await admin((c) => c.query(`drop database ${name} with (force)`));
    },
  };
}
