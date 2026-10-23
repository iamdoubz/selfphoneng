// SPDX-License-Identifier: AGPL-3.0-or-later
// Startup order (04 §1).
import { resolve } from 'node:path';
import { AmiClient } from './ami/client.ts';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { setSecretKey } from './crypto/secrets.ts';
import { createDb, migrationsPending, runMigrations } from './db/client.ts';
import { backupBeforeMigrate } from './services/backup.ts';
import { clearRestartIfRestarted, createGenerator } from './generator/index.ts';
import { ensureInitialAdmin } from './services/bootstrap.ts';
import { LiveState } from './live/state.ts';
import { smtpMailer } from './services/mail.ts';
import { watchEmergencies } from './services/emergency.ts';
import { watchVoicemail } from './services/voicemail.ts';
import { syncAstDb } from './services/astdb.ts';
import { watchToggles } from './services/toggles.ts';
import { watchCdr } from './services/cdr.ts';
import { watchQueueCalls } from './services/queuestats.ts';
import { watchPinChanges } from './services/vmpin.ts';
import { startJobs } from './jobs.ts';
import { watchWebhooks } from './services/webhooks.ts';
import { watchEvents } from './services/events.ts';
import { callerNameToken } from './contacts/callername.ts';

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
  rtpPorts: { start: config.RTP_PORT_START, end: config.RTP_PORT_END },
  callerNames: {
    url: `http://127.0.0.1:${config.API_PORT}/api/internal/caller-name`,
    token: callerNameToken(config.APP_SECRET),
  },
  log: app.log,
  onApplied: (r) => {
    live.emit('message', {
      type: 'system.configApplied',
      data: { ok: r.ok, error: r.error, restartRequired: r.restartRequired },
    });
    void live.loadFromDb().catch((err) => app.log.error({ err }, 'live reload failed'));
    if (ami.isConnected())
      void live.refreshQueues().catch((err) => app.log.error({ err }, 'queue reload failed'));
  },
});
app.decorate('generator', generator);
app.decorate('ami', ami);
const sendMail = smtpMailer(db);
app.decorate('sendMail', sendMail);
watchEmergencies({ db, ami, live, send: sendMail, log: app.log }, ami);
watchToggles({ db, ami, live, log: app.log }, ami);
watchQueueCalls({ db, log: app.log }, ami);
watchPinChanges({ db, log: app.log, requestApply: () => generator.requestApply('phone-pin') }, ami);
const history = watchCdr({ db, log: app.log, recordingsDir: resolve(config.RECORDINGS_DIR) }, ami);
const voicemail = watchVoicemail(
  {
    db,
    spoolDir: resolve(config.VOICEMAIL_DIR),
    ami,
    live,
    send: sendMail,
    publicHost: config.PUBLIC_HOSTNAME,
    log: app.log,
  },
  ami,
);
app.decorate('voicemail', voicemail);
app.decorate('live', live);
watchWebhooks(db, live, app.log);
watchEvents(db, live, ami, app.log);

// A new version with database changes: back up first, so a bad update can be undone (08 §3.1).
const pending = await migrationsPending(db);
if (pending) {
  if (config.SKIP_BACKUP_BEFORE_MIGRATE)
    app.log.warn('database changes pending; SKIP_BACKUP_BEFORE_MIGRATE is set, so no backup first');
  else {
    app.log.info(pending, 'database changes pending: backing up first');
    const backup = await backupBeforeMigrate(config, db, pending).catch((err: unknown) => {
      app.log.fatal(
        { err, dir: config.BACKUPS_DIR },
        'backup before migrating failed, so the database was left as it is. Fix the cause ' +
          '(the backups folder must exist and be writable, with free space), or set ' +
          'SKIP_BACKUP_BEFORE_MIGRATE=true to migrate without one',
      );
      process.exit(1);
    });
    // update.sh finds this line to restore from (the name, then the message).
    app.log.info(
      { backup: backup.name },
      backup.made ? 'backup before migrating made' : 'backup before migrating made earlier, kept',
    );
  }
}
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
    await syncAstDb(db, ami); // PostgreSQL wins (04 §5.5)
    await generator.apply({ trigger: 'startup', force: true });
    await live.loadFromAsterisk();
    await voicemail.scanAll();
    await history.catchUp();
  })().catch((err) => app.log.error({ err }, 'startup sync failed'));
});
ami.start();

const stopJobs = startJobs({
  config,
  db,
  ami,
  live,
  generator,
  voicemail,
  send: sendMail,
  log: app.log,
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    generator.cancelPending();
    stopJobs();
    history.stop();
    ami.stop();
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
