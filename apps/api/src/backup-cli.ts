// SPDX-License-Identifier: AGPL-3.0-or-later
// `node dist/backup-cli.js` in the api container: one backup like the one before migrating
// (database, voicemail, custom sounds, music on hold; no recordings), its file name printed.
// scripts/update.sh runs it in the running (old) api before updating.
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { backupBeforeMigrate } from './services/backup.ts';

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
try {
  console.log((await backupBeforeMigrate(config, db)).name);
} finally {
  await pool.end();
}
