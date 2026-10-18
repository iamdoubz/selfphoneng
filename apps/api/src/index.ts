// SPDX-License-Identifier: AGPL-3.0-or-later
// Startup order (04 §1).
import { resolve } from 'node:path';
import { AmiClient } from './ami/client.ts';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { setSecretKey } from './crypto/secrets.ts';
import { createDb, runMigrations } from './db/client.ts';
import { clearRestartIfRestarted, createGenerator } from './generator/index.ts';
import { ensureInitialAdmin } from './services/bootstrap.ts';
import { LiveState } from './live/state.ts';
import { smtpMailer } from './services/mail.ts';
import { watchEmergencies } from './services/emergency.ts';

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
const ami = new AmiClient({
  host: config.AMI_HOST,
  port: config.AMI_PORT,
  username: config.AMI_USERNAME,
  secret: config.AMI_SECRET,
  logger: app.log,
});
const live = new LiveState(db, ami);
const generator = createGenerator({
  db,
  ami,
  dir: resolve(config.ASTERISK_CONFIG_DIR),
  log: app.log,
  onApplied: (r) => {
    live.emit('message', {
      type: 'system.configApplied',
      data: { ok: r.ok, error: r.error, restartRequired: r.restartRequired },
    });
    void live.loadFromDb().catch((err) => app.log.error({ err }, 'live reload failed'));
  },
});
app.decorate('generator', generator);
app.decorate('ami', ami);
const sendMail = smtpMailer(db);
app.decorate('sendMail', sendMail);
watchEmergencies({ db, ami, live, send: sendMail, log: app.log }, ami);
app.decorate('live', live);

await runMigrations(db);
app.log.info('database migrated');
const admin = await ensureInitialAdmin(
  db,
  config.INITIAL_ADMIN_EMAIL,
  config.INITIAL_ADMIN_PASSWORD,
);
if (admin === 'created')
  app.log.info({ email: config.INITIAL_ADMIN_EMAIL }, 'initial admin created');
await app.listen({ host: '127.0.0.1', port: config.API_PORT });

await live.loadFromDb();
// Every (re)connect: Asterisk may have restarted, so push the full config again, then read its
// state (after the apply, so hints for new extensions exist). TODO(M6): sync AstDB first (04 §5.5).
ami.on('connected', () => {
  void (async () => {
    if (await clearRestartIfRestarted(db, ami))
      app.log.info('asterisk restarted: restart no longer required');
    await generator.apply({ trigger: 'startup', force: true });
    await live.loadFromAsterisk();
  })().catch((err) => app.log.error({ err }, 'startup sync failed'));
});
ami.start();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    generator.cancelPending();
    ami.stop();
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
