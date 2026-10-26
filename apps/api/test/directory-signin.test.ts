// SPDX-License-Identifier: AGPL-3.0-or-later
// 12 §4.3: who a directory entry may connect to by email, who may disconnect it (§4.5), and a
// directory that's down counting as a failed sign-in (§4.2).
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetLoginLimiter } from '../src/auth/login-limiter.ts';
import { userIdentities, users } from '../src/db/schema.ts';
import { setSetting } from '../src/services/settings.ts';
import { directorySignIn } from '../src/sso/directory.ts';
import type { DirectoryEntry } from '../src/sso/ldap.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const log = { info: () => {} };

describe.skipIf(!hasTestDb)('directory accounts by email (12 §4.3)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let n = 0;
  const entry = (email: string): DirectoryEntry => ({
    dn: `uid=e${++n}`,
    id: `id-${n}`,
    email,
    name: email,
    admin: null,
  });
  const connected = async (userId: string) =>
    (await t.db.select().from(userIdentities).where(eq(userIdentities.userId, userId))).length;

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
  });
  afterAll(() => t?.close());

  it('never connects an admin, or someone who set their own password', async () => {
    const admin = await t.addUser('boss@example.com', 'boss-password-1', 'admin');
    const own = await t.addUser('own@example.com', 'own-password-1');
    for (const u of [admin, own]) {
      expect(await directorySignIn(t.db, log, entry(u.email), '127.0.0.1')).toBeNull();
      expect(await connected(u.id)).toBe(0);
    }
  });

  it('connects someone with no password, or only the temporary one', async () => {
    const fresh = await t.addUser('fresh@example.com', 'temporary-pw-1');
    await t.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, fresh.id));
    const none = await t.addUser('none@example.com', 'unused-pw-1');
    await t.db.update(users).set({ passwordHash: null }).where(eq(users.id, none.id));
    for (const u of [fresh, none]) {
      expect((await directorySignIn(t.db, log, entry(u.email), '127.0.0.1'))?.id).toBe(u.id);
      expect(await connected(u.id)).toBe(1);
    }
  });

  it('only an admin can disconnect a directory account (a leaver must stay checked)', async () => {
    const u = await t.addUser('leaver@example.com', 'leaver-password-1');
    await t.db.insert(userIdentities).values({ userId: u.id, kind: 'ldap', subject: 'leaver-id' });
    const mine = await t.login(u.email, 'leaver-password-1');
    const self = await t.app.inject({
      method: 'DELETE',
      url: '/api/me/identities/ldap',
      headers: { ...H, cookie: mine },
    });
    expect(self.statusCode).toBe(403);
    expect(await connected(u.id)).toBe(1);
    const admin = await t.login(ADMIN.email, ADMIN.password);
    const byAdmin = await t.app.inject({
      method: 'DELETE',
      url: `/api/users/${u.id}/identities/ldap`,
      headers: { ...H, cookie: admin },
    });
    expect(byAdmin.statusCode).toBe(200);
    expect(await connected(u.id)).toBe(0);
  });

  it('a directory that is down still counts each failed password: no free guesses', async () => {
    resetLoginLimiter();
    await setSetting(t.db, 'auth.ldap', {
      enabled: true,
      preset: 'lldap',
      url: 'ldap://127.0.0.1:1', // nothing listens there
      startTls: false,
      bindDn: null,
      bindPasswordEnc: null,
      baseDn: 'dc=example,dc=com',
      userFilter: '(uid={login})',
      idAttribute: 'entryUUID',
      emailAttribute: 'mail',
      nameAttribute: 'displayName',
      adminFilter: null,
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++)
        codes.push(
          (
            await t.app.inject({
              method: 'POST',
              url: '/api/auth/login',
              headers: H,
              payload: { login: ADMIN.email, password: `guess-${i}` },
            })
          ).statusCode,
        );
      expect(codes).toEqual([503, 503, 503, 503, 503, 429]);
      // Even the right password waits now: the guesses were counted.
      const right = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: H,
        payload: { login: ADMIN.email, password: ADMIN.password },
      });
      expect(right.statusCode).toBe(429);
    } finally {
      await setSetting(t.db, 'auth.ldap', null);
      resetLoginLimiter();
    }
  });
});
