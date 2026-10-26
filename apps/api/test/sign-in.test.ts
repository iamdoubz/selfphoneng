// SPDX-License-Identifier: AGPL-3.0-or-later
// 12 S1: ways to sign in, the sign-in mode, and the admin with a password kept as the way in.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessions, userIdentities, users } from '../src/db/schema.ts';
import { resetLoginLimiter } from '../src/auth/login-limiter.ts';
import { setSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('sign-in (12 S1)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    admin = await t.login(ADMIN.email, ADMIN.password);
  });
  afterAll(() => t?.close());
  beforeEach(() => resetLoginLimiter());

  const post = (url: string, payload: object, cookie?: string) =>
    t.app.inject({ method: 'POST', url, payload, headers: { ...H, ...(cookie && { cookie }) } });

  it('GET /api/auth/methods is public and offers passwords only', async () => {
    const r = await t.app.inject({ url: '/api/auth/methods' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ mode: 'password', ldap: false, oidc: null });
  });

  it('signs in with `login`, and still with `email`; the session says how', async () => {
    const r = await post('/api/auth/login', { login: ADMIN.email, password: ADMIN.password });
    expect(r.statusCode).toBe(200);
    expect(r.json().user.signIn).toEqual({ password: true, oidc: null, ldap: false });
    const rows = await t.db.select({ method: sessions.method }).from(sessions);
    expect(rows.every((s) => s.method === 'password')).toBe(true);
  });

  it('a user without a password fails like a wrong password, and has none to change', async () => {
    const u = await t.addUser('nopw@example.com', 'temporary-pass-1');
    const cookie = await t.login('nopw@example.com', 'temporary-pass-1');
    await t.db.update(users).set({ passwordHash: null }).where(eq(users.id, u.id));
    const r = await post('/api/auth/login', { login: 'nopw@example.com', password: 'anything' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toBe('Wrong email or password');
    const c = await post(
      '/api/auth/change-password',
      { currentPassword: 'x', newPassword: 'a-new-password-1' },
      cookie,
    );
    expect(c.statusCode).toBe(400);
  });

  it('users show their connected accounts', async () => {
    const u = await t.addUser('linked@example.com', 'linked-password-1');
    await t.db
      .insert(userIdentities)
      .values({ userId: u.id, kind: 'oidc', subject: 'https://kc/realms/x abc', email: 'l@kc' });
    const r = await t.app.inject({ url: `/api/users/${u.id}`, headers: { cookie: admin } });
    expect(r.json().signIn).toEqual({
      password: true,
      oidc: { email: 'l@kc', groups: [] },
      ldap: false,
    });
  });

  it('auth.mode can only be password until OpenID Connect is set up', async () => {
    const r = t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { 'auth.mode': 'mixed' },
      headers: { ...H, cookie: admin },
    });
    expect((await r).statusCode).toBe(400);
  });

  it('OpenID-only mode refuses passwords, except for admins', async () => {
    await t.addUser('plain@example.com', 'plain-password-1');
    await setSetting(t.db, 'auth.mode', 'oidc');
    try {
      const r = await post('/api/auth/login', {
        login: 'plain@example.com',
        password: 'plain-password-1',
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('password_sign_in_off');
      const a = await post('/api/auth/login', { login: ADMIN.email, password: ADMIN.password });
      expect(a.statusCode).toBe(200);
    } finally {
      await setSetting(t.db, 'auth.mode', 'password');
    }
  });

  it('the last active admin with a password stays, even with other admins', async () => {
    const [me] = await t.db.select().from(users).where(eq(users.email, ADMIN.email));
    const other = await t.addUser('sso-admin@example.com', 'sso-admin-pass-1', 'admin');
    await t.db.update(users).set({ passwordHash: null }).where(eq(users.id, other.id));
    const demote = await t.app.inject({
      method: 'PATCH',
      url: `/api/users/${me!.id}`,
      payload: { role: 'user' },
      headers: { ...H, cookie: admin },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.message).toBe('This is the last active admin with a password');
    // An admin without a password can go: the one with a password is still there.
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/users/${other.id}`,
      headers: { ...H, cookie: admin },
    });
    expect(del.statusCode).toBe(200);
  });

  const patch = (payload: object, cookie = admin) =>
    t.app.inject({ method: 'PATCH', url: '/api/settings', payload, headers: { ...H, cookie } });

  it('a stored secret never goes to a new server: the directory, OpenID and email', async () => {
    const ldap = {
      enabled: false,
      preset: 'lldap',
      url: 'ldaps://dir.example.com',
      startTls: false,
      bindDn: 'uid=svc,dc=example,dc=com',
      bindPassword: 'service-pw-1',
      baseDn: 'dc=example,dc=com',
      userFilter: '(uid={login})',
      idAttribute: 'entryUUID',
      emailAttribute: 'mail',
      nameAttribute: 'displayName',
      adminFilter: '',
    };
    expect((await patch({ 'auth.ldap': ldap })).statusCode).toBe(200);
    const { bindPassword: _, ...keep } = ldap;
    expect((await patch({ 'auth.ldap': keep })).statusCode).toBe(200); // same server: kept
    const moved = await patch({ 'auth.ldap': { ...keep, url: 'ldaps://evil.example' } });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error.message).toMatch(/enter its password again/);
    const test = await post(
      '/api/settings/auth/ldap/test',
      { ...keep, url: 'ldaps://evil.example' },
      admin,
    );
    expect(test.statusCode).toBe(400); // Test too: it would bind there with the stored password
    const otherDn = await patch({
      'auth.ldap': { ...keep, bindDn: 'uid=other,dc=example,dc=com' },
    });
    expect(otherDn.statusCode).toBe(400);

    const oidc = {
      label: 'Keycloak',
      issuer: 'https://kc.example.com/realms/x',
      clientId: 'selfphoneng',
      clientSecret: 'client-secret-1',
      scopes: 'openid email profile',
      groupsClaim: 'groups',
      adminGroups: [],
      allowedGroups: [],
      trustEmail: false,
    };
    expect((await patch({ 'auth.oidc': oidc })).statusCode).toBe(200);
    const { clientSecret: __, ...noSecret } = oidc;
    const newIssuer = await patch({ 'auth.oidc': { ...noSecret, issuer: 'https://evil.example' } });
    expect(newIssuer.statusCode).toBe(400);
    expect(newIssuer.json().error.message).toMatch(/client secret again/);
    expect((await patch({ 'auth.oidc': noSecret })).json()['auth.oidc'].hasClientSecret).toBe(true);

    const smtp = {
      host: 'mail.example.com',
      port: 587,
      secure: false,
      username: 'pbx',
      password: 'smtp-pw-1',
      from: 'PBX <pbx@example.com>',
    };
    expect((await patch({ smtp })).statusCode).toBe(200);
    const { password: ___, ...smtpKeep } = smtp;
    expect((await patch({ smtp: smtpKeep })).json().smtp.hasPassword).toBe(true);
    expect(
      (await patch({ smtp: { ...smtpKeep, host: 'evil.example' } })).json().smtp.hasPassword,
    ).toBe(false);
    await patch({ 'auth.ldap': null, 'auth.oidc': null, smtp: null });
  });

  it('a role set by the directory or the provider is read-only here (409 role_managed)', async () => {
    const u = await t.addUser('managed@example.com', 'managed-pw-12');
    await t.db.insert(userIdentities).values({ userId: u.id, kind: 'ldap', subject: 'managed-id' });
    const ldap = {
      enabled: true,
      preset: 'lldap' as const,
      url: 'ldaps://dir.example.com',
      startTls: false,
      bindDn: null,
      bindPasswordEnc: null,
      baseDn: 'dc=example,dc=com',
      userFilter: '(uid={login})',
      idAttribute: 'entryUUID',
      emailAttribute: 'mail',
      nameAttribute: 'displayName',
      adminFilter: null,
    };
    await setSetting(t.db, 'auth.ldap', ldap);
    const setRole = (role: string) =>
      t.app.inject({
        method: 'PATCH',
        url: `/api/users/${u.id}`,
        payload: { role },
        headers: { ...H, cookie: admin },
      });
    try {
      expect((await setRole('admin')).statusCode).toBe(200); // no admin filter: set here
      await setRole('user');
      await setSetting(t.db, 'auth.ldap', { ...ldap, adminFilter: '(memberOf=cn=pbx-admins)' });
      const r = await setRole('admin');
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('role_managed');
      const dto = await t.app.inject({ url: `/api/users/${u.id}`, headers: { cookie: admin } });
      expect(dto.json().roleFrom).toBe('the directory');
    } finally {
      await setSetting(t.db, 'auth.ldap', null);
    }
  });

  it('an empty Contrack update is a 400, not a 500', async () => {
    const r = await t.app.inject({
      method: 'PATCH',
      url: '/api/me/contrack',
      payload: {},
      headers: { ...H, cookie: admin },
    });
    expect(r.statusCode).toBe(400);
  });
});
