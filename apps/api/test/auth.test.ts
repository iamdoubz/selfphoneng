// SPDX-License-Identifier: AGPL-3.0-or-later
// M1-T3 acceptance (09-roadmap) plus the auth rules in 04 §2.
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, users } from '../src/db/schema.ts';
import { requireAdmin } from '../src/auth/guards.ts';
import { resetLoginLimiter } from '../src/auth/login-limiter.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('auth', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let adminPassword = ADMIN.password;
  beforeAll(async () => {
    // A stand-in admin route until the real admin routes exist.
    t = await createTestApp((app) =>
      app.get('/api/admin-probe', { preHandler: requireAdmin }, async () => ({ ok: true })),
    );
  });
  afterAll(() => t?.close());
  beforeEach(() => resetLoginLimiter());

  const login = (email: string, password: string, headers: Record<string, string> = H) =>
    t.app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { email, password } });
  const cookieOf = (r: Awaited<ReturnType<typeof login>>) =>
    `sp_session=${r.cookies.find((c) => c.name === 'sp_session')!.value}`;
  const get = (url: string, cookie?: string) =>
    t.app.inject({ url, headers: cookie ? { cookie } : {} });

  it('good login sets an HttpOnly, Secure, SameSite=Lax session cookie', async () => {
    const r = await login(ADMIN.email, adminPassword);
    expect(r.statusCode).toBe(200);
    expect(r.cookies.find((x) => x.name === 'sp_session')).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 1209600,
    });
    expect(r.json().user).toMatchObject({
      email: ADMIN.email,
      role: 'admin',
      mustChangePassword: true,
    });
  });

  it('emails match case-insensitively', async () => {
    expect((await login(ADMIN.email.toUpperCase(), adminPassword)).statusCode).toBe(200);
  });

  it('bad password → 401 and an audited login_failed with the IP', async () => {
    const r = await login(ADMIN.email, 'wrong-password');
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('unauthorized');
    const [row] = await t.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1);
    expect(row).toMatchObject({ action: 'login_failed', actorIp: '127.0.0.1' });
    expect(JSON.stringify(row)).not.toContain('wrong-password');
  });

  it('unknown email → the same 401', async () => {
    expect((await login('nobody@example.com', 'whatever-pw')).statusCode).toBe(401);
  });

  it('6th failure from one IP → 429, even with the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await login(ADMIN.email, `bad-${i}`)).statusCode).toBe(401);
    expect((await login(ADMIN.email, 'bad-6')).statusCode).toBe(429);
    expect((await login(ADMIN.email, adminPassword)).statusCode).toBe(429);
  });

  it('POST without X-Requested-With → 403', async () => {
    const r = await login(ADMIN.email, adminPassword, {});
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('csrf');
  });

  it('must_change_password blocks everything outside /api/auth/* until changed', async () => {
    const cookie = cookieOf(await login(ADMIN.email, adminPassword));
    const blocked = await get('/api/admin-probe', cookie);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('password_change_required');
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(200);

    const change = (newPassword: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { ...H, cookie },
        payload: { currentPassword: adminPassword, newPassword },
      });
    expect((await change('short')).statusCode).toBe(400);
    expect((await change('qwertyuiop')).json().error.message).toMatch(/too common/);
    expect((await change('a-much-better-passphrase')).statusCode).toBe(200);
    adminPassword = 'a-much-better-passphrase';
    expect((await get('/api/admin-probe', cookie)).statusCode).toBe(200);
  });

  it('changing the password logs out other sessions', async () => {
    const a = cookieOf(await login(ADMIN.email, adminPassword));
    const b = cookieOf(await login(ADMIN.email, adminPassword));
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { ...H, cookie: a },
      payload: { currentPassword: adminPassword, newPassword: 'another-good-passphrase' },
    });
    expect(r.statusCode).toBe(200);
    adminPassword = 'another-good-passphrase';
    expect((await get('/api/auth/me', a)).statusCode).toBe(200);
    expect((await get('/api/auth/me', b)).statusCode).toBe(401);
  });

  it('non-admin hitting an admin route → 403', async () => {
    await t.addUser('user@example.com', 'user-password-123');
    const cookie = cookieOf(await login('user@example.com', 'user-password-123'));
    const r = await get('/api/admin-probe', cookie);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('forbidden');
  });

  it('no cookie → 401; logout ends the session', async () => {
    expect((await get('/api/auth/me')).statusCode).toBe(401);
    const cookie = cookieOf(await login(ADMIN.email, adminPassword));
    const out = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...H, cookie },
    });
    expect(out.statusCode).toBe(200);
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(401);
  });

  it('inactive users cannot log in', async () => {
    const u = await t.addUser('gone@example.com', 'gone-password-123');
    await t.db.update(users).set({ isActive: false }).where(eq(users.id, u.id));
    expect((await login('gone@example.com', 'gone-password-123')).statusCode).toBe(401);
  });

  it('every login event is audited', async () => {
    const actions = (await t.db.select({ a: auditLog.action }).from(auditLog)).map((r) => r.a);
    expect(actions).toEqual(
      expect.arrayContaining(['create', 'login', 'login_failed', 'logout', 'password_changed']),
    );
  });

  it('healthz checks the DB; the SPA fallback skips /api and /prov', async () => {
    expect((await get('/healthz')).json()).toEqual({ ok: true });
    expect((await get('/admin/users')).body).toBe('<h1>spa</h1>');
    expect((await get('/api/nope')).statusCode).toBe(404);
    expect((await get('/prov/x.cfg')).statusCode).toBe(404);
  });

  it('M11-T1: security headers on every response (08 §2.4)', async () => {
    for (const url of ['/admin/users', '/api/nope', '/healthz']) {
      const h = (await get(url)).headers;
      expect(h['content-security-policy'], url).toBe(
        "default-src 'self'; connect-src 'self' wss://pbx.test; media-src 'self' blob:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      );
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['referrer-policy']).toBe('same-origin');
      expect(h['permissions-policy']).toBe('microphone=(self), camera=()');
    }
  });
});
