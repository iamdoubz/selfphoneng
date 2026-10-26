// SPDX-License-Identifier: AGPL-3.0-or-later
// 12 §4.5: the hourly directoryCheck, against a fake directory lookup.
import { eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, sessions, userIdentities, users } from '../src/db/schema.ts';
import { getSetting, setSetting } from '../src/services/settings.ts';
import { checkDirectory } from '../src/sso/directory.ts';
import type { DirectoryEntry, LdapSettings } from '../src/sso/ldap.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const log = { info: () => {}, warn: () => {} };
const LDAP: LdapSettings = {
  enabled: true,
  preset: 'lldap',
  url: 'ldaps://dir.example.com',
  startTls: false,
  bindDn: null,
  bindPasswordEnc: null,
  baseDn: 'ou=people,dc=example,dc=com',
  userFilter: '(uid={login})',
  idAttribute: 'entryUUID',
  emailAttribute: 'mail',
  nameAttribute: 'displayName',
  adminFilter: '(memberOf=cn=pbx-admins)',
};

describe.skipIf(!hasTestDb)('directoryCheck (12 §4.5)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let n = 0;

  /** A user here with a directory account `id`. */
  const member = async (role: 'admin' | 'user' = 'user') => {
    const u = await t.addUser(`dir${++n}@example.com`, 'local-password-1', role);
    const dirId = `uuid-${n}`;
    await t.db.insert(userIdentities).values({ userId: u.id, kind: 'ldap', subject: dirId });
    return { ...u, dirId };
  };
  const entry = (id: string, admin: boolean | null, email = `${id}@dir.example.com`) =>
    [id, { dn: `uid=${id}`, id, email, name: id, admin }] as [string, DirectoryEntry];
  const run = (found: [string, DirectoryEntry][] | Error) =>
    checkDirectory({
      db: t.db,
      log,
      lookup: () =>
        found instanceof Error ? Promise.reject(found) : Promise.resolve(new Map(found)),
    });
  const user = async (id: string) => (await t.db.select().from(users).where(eq(users.id, id)))[0]!;
  const warning = () => getSetting(t.db, 'system.directoryWarning');

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
  });
  afterAll(() => t?.close());
  beforeEach(async () => {
    await t.db.delete(userIdentities);
    await t.db.update(users).set({ role: 'user' }).where(ne(users.email, ADMIN.email));
    await setSetting(t.db, 'auth.ldap', LDAP);
  });

  it('updates who is still there, and disables who is gone', async () => {
    const [stays, promoted, leaves] = [await member(), await member(), await member()];
    await t.login(leaves.email, 'local-password-1');
    await setSetting(t.db, 'system.directoryWarning', 'old');
    await run([entry(stays.dirId, false, 'new@dir.example.com'), entry(promoted.dirId, true)]);

    expect(await user(stays.id)).toMatchObject({ isActive: true, role: 'user' });
    const [ident] = await t.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, stays.id));
    expect(ident!.email).toBe('new@dir.example.com');
    expect((await user(promoted.id)).role).toBe('admin');
    expect((await user(leaves.id)).isActive).toBe(false);
    expect(await t.db.select().from(sessions).where(eq(sessions.userId, leaves.id))).toEqual([]);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, leaves.id));
    expect(audits.map((a) => a.action)).toContain('directory_disabled');
    expect(await warning()).toBeNull();
  });

  it('changes nothing and warns on the dashboard when the directory is down', async () => {
    const a = await member();
    await run(new Error('connect ECONNREFUSED'));
    expect((await user(a.id)).isActive).toBe(true);
    expect(await warning()).toMatch(/couldn't reach the directory \(connect ECONNREFUSED\)/);
    const admin = await t.login(ADMIN.email, ADMIN.password);
    const r = await t.app.inject({
      url: '/api/system/warnings',
      headers: { ...H, cookie: admin },
    });
    expect(r.json().items).toContainEqual(
      expect.objectContaining({ code: 'directory_check', link: '/admin/settings/sign-in' }),
    );
  });

  it('disables nobody when most people would go (a broken filter, not a layoff)', async () => {
    const all = [await member(), await member(), await member(), await member()];
    await run([entry(all[0]!.dirId, null)]);
    for (const u of all) expect((await user(u.id)).isActive).toBe(true);
    expect(await warning()).toMatch(/would disable 3 of 4 people/);
  });

  it('two of four gone is not "most": they are disabled', async () => {
    const all = [await member(), await member(), await member(), await member()];
    await run([entry(all[0]!.dirId, null), entry(all[1]!.dirId, null)]);
    expect((await user(all[2]!.id)).isActive).toBe(false);
    expect((await user(all[3]!.id)).isActive).toBe(false);
  });

  it('keeps the last active admin with a password', async () => {
    const [me] = await t.db.select().from(users).where(eq(users.email, ADMIN.email));
    await t.db.insert(userIdentities).values({ userId: me!.id, kind: 'ldap', subject: 'admin-id' });
    await run([]);
    expect((await user(me!.id)).isActive).toBe(true);
    await run([entry('admin-id', false)]);
    expect((await user(me!.id)).role).toBe('admin');
  });

  it('does nothing with the directory off', async () => {
    const a = await member();
    await setSetting(t.db, 'auth.ldap', { ...LDAP, enabled: false });
    await setSetting(t.db, 'system.directoryWarning', 'old');
    await run([]);
    expect((await user(a.id)).isActive).toBe(true);
    expect(await warning()).toBeNull();
  });
});
