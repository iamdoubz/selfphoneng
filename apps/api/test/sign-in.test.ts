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
});
