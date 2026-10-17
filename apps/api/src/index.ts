// SPDX-License-Identifier: AGPL-3.0-or-later
// Startup order (04 §1).
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { setSecretKey } from './crypto/secrets.ts';
import { createDb, runMigrations } from './db/client.ts';
import { ensureInitialAdmin } from './services/bootstrap.ts';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}
setSecretKey(config.APP_SECRET);

const { db, pool } = createDb(config.DATABASE_URL);
const app = buildApp(config, db); // creates the pino logger
await runMigrations(db);
app.log.info('database migrated');
if (
  (await ensureInitialAdmin(db, config.INITIAL_ADMIN_EMAIL, config.INITIAL_ADMIN_PASSWORD)) ===
  'created'
)
  app.log.info({ email: config.INITIAL_ADMIN_EMAIL }, 'initial admin created');
await app.listen({ host: '127.0.0.1', port: config.API_PORT });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
