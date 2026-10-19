// SPDX-License-Identifier: AGPL-3.0-or-later
// A full api on a throwaway database, for Fastify inject() tests.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { setSecretKey } from '../src/crypto/secrets.ts';
import { users } from '../src/db/schema.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { resetLoginLimiter } from '../src/auth/login-limiter.ts';
import { ensureInitialAdmin } from '../src/services/bootstrap.ts';
import { EventEmitter } from 'node:events';
import { createGenerator } from '../src/generator/index.ts';
import { LiveState } from '../src/live/state.ts';
import type { AmiMessage } from '../src/ami/events.ts';
import type { Mail } from '../src/services/mail.ts';
import { watchVoicemail } from '../src/services/voicemail.ts';
import { createTestDb } from './db.ts';

/** Stand-in for AmiClient: records commands; flip `connected` to simulate Asterisk going away. */
export function fakeAmi() {
  const commands: string[] = [];
  const events = new EventEmitter();
  return {
    connected: true,
    commands,
    events,
    on: events.on.bind(events),
    off: events.off.bind(events),
    /** Canned list responses by Action name. */
    lists: {} as Record<string, AmiMessage[]>,
    actions: [] as Record<string, string>[],
    async actionList(f: Record<string, string>): Promise<AmiMessage[]> {
      return this.lists[f.Action!] ?? [];
    },
    async action(f: Record<string, string>) {
      this.actions.push(f);
      return { Response: 'Success' };
    },
    isConnected() {
      return this.connected;
    },
    async command(c: string) {
      commands.push(c);
      return '';
    },
  };
}

export const ADMIN = { email: 'admin@example.com', password: 'initial-admin-pw' };
export const H = { 'x-requested-with': 'selfphoneng' };

export async function createTestApp(extend?: (app: ReturnType<typeof buildApp>) => void) {
  const t = await createTestDb();
  const config = loadConfig({
    APP_SECRET: randomBytes(32).toString('base64'),
    PUBLIC_HOSTNAME: 'pbx.test',
    DATABASE_URL: t.url,
    INITIAL_ADMIN_EMAIL: ADMIN.email,
    INITIAL_ADMIN_PASSWORD: ADMIN.password,
    AMI_SECRET: 'ami-secret-123',
    LOG_LEVEL: 'fatal',
    RECORDINGS_DIR: mkdtempSync(join(tmpdir(), 'sp-rec-')),
    SOUNDS_DIR: mkdtempSync(join(tmpdir(), 'sp-sounds-')),
    MOH_DIR: mkdtempSync(join(tmpdir(), 'sp-moh-')),
  });
  setSecretKey(config.APP_SECRET);
  const pub = mkdtempSync(join(tmpdir(), 'sp-public-'));
  writeFileSync(join(pub, 'index.html'), '<h1>spa</h1>');
  const app = buildApp(config, t.db, pub);
  const ami = fakeAmi();
  const genDir = mkdtempSync(join(tmpdir(), 'sp-gen-'));
  const live = new LiveState(t.db, ami);
  app.decorate('live', live);
  app.decorate('ami', ami);
  /** Every email the app sent; set mail.fail to make sending throw. */
  const mails: Mail[] = [];
  const mail = { fail: null as string | null };
  app.decorate('sendMail', async (m: Mail) => {
    if (mail.fail) throw new Error(mail.fail);
    mails.push(m);
  });
  app.decorate(
    'generator',
    createGenerator({
      db: t.db,
      ami,
      dir: genDir,
      log: app.log,
      debounceMs: 20,
      onApplied: () => void live.loadFromDb().catch(() => {}), // may land after close()
    }),
  );
  const spoolDir = mkdtempSync(join(tmpdir(), 'sp-vm-'));
  app.decorate(
    'voicemail',
    watchVoicemail(
      {
        db: t.db,
        spoolDir,
        ami,
        live,
        send: (m) => app.sendMail(m),
        publicHost: 'pbx.test',
        log: app.log,
      },
      ami.events,
    ),
  );
  extend?.(app);
  await ensureInitialAdmin(t.db, ADMIN.email, ADMIN.password);
  resetLoginLimiter();
  await app.ready();

  /** Logs in and returns the Cookie header value. */
  async function login(email: string, password: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { email, password },
    });
    if (r.statusCode !== 200) throw new Error(`login failed: ${r.statusCode} ${r.body}`);
    const c = r.cookies.find((x) => x.name === 'sp_session')!;
    return `sp_session=${c.value}`;
  }

  /** Creates a user directly in the DB (no password-change requirement). */
  async function addUser(email: string, password: string, role: 'admin' | 'user' = 'user') {
    const [u] = await t.db
      .insert(users)
      .values({ email, displayName: email, passwordHash: await hashPassword(password), role })
      .returning();
    return u!;
  }

  async function clearMustChange(email: string) {
    await t.db.update(users).set({ mustChangePassword: false }).where(eq(users.email, email));
  }

  return {
    app,
    db: t.db,
    ami,
    mails,
    mail,
    live,
    genDir,
    spoolDir,
    login,
    addUser,
    clearMustChange,
    close: async () => {
      await app.close();
      await t.drop();
    },
  };
}
