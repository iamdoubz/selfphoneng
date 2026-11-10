// SPDX-License-Identifier: AGPL-3.0-or-later
// 15: adding, listing, removing and signing in with a passkey.
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetLoginLimiter } from '../src/auth/login-limiter.ts';
import { auditLog, passkeys, sessions, users } from '../src/db/schema.ts';
import { setSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';
import { fakeAuthenticator } from './fake-passkey.ts';

describe.skipIf(!hasTestDb)('passkeys', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  type Req = (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  const withHeaders =
    (headers: Record<string, string>): Req =>
    (method, url, payload) =>
      t.app.inject({ method: method as 'GET', url, payload: payload as object, headers });
  const anon = withHeaders(H);
  let dan: Req;
  let danId: string;
  const PW = 'dan-password-123';
  const u = (b: Buffer) => b.toString('base64url');
  const key = fakeAuthenticator();

  /** What the browser posts after navigator.credentials.create. */
  async function add(as: Req, a = key, extra: Record<string, unknown> = {}) {
    const o = (await as('POST', '/api/auth/passkeys/options')).json();
    const c = a.create(o.challenge);
    return as('POST', '/api/auth/passkeys', {
      name: 'Laptop',
      password: PW,
      id: u(c.id),
      clientDataJSON: u(c.clientDataJSON),
      authenticatorData: u(c.authenticatorData),
      publicKey: u(c.publicKey),
      alg: c.alg,
      ...extra,
    });
  }
  /** …and after navigator.credentials.get. */
  async function signIn(a = key, o: Parameters<typeof key.get>[1] = {}) {
    const { challenge } = (await anon('POST', '/api/auth/passkey/options')).json();
    const g = a.get(challenge, o);
    return anon('POST', '/api/auth/passkey/login', {
      id: u(a.id),
      clientDataJSON: u(g.clientDataJSON),
      authenticatorData: u(g.authenticatorData),
      signature: u(g.signature),
    });
  }

  beforeAll(async () => {
    t = await createTestApp();
    danId = (await t.addUser('dan@example.com', PW)).id;
    dan = withHeaders({ ...H, cookie: await t.login('dan@example.com', PW) });
  });
  afterAll(() => t?.close());

  it('adds a passkey with the password, once', async () => {
    const o = (await dan('POST', '/api/auth/passkeys/options')).json();
    expect(o).toMatchObject({
      rpId: 'pbx.test',
      user: { id: danId, name: 'dan@example.com' },
      algs: [-7, -8, -257],
      exclude: [],
    });
    expect((await add(dan, key, { password: 'wrong' })).statusCode).toBe(400);
    expect(await t.db.select().from(passkeys)).toHaveLength(0);

    expect((await add(dan)).statusCode).toBe(200);
    const [row] = await t.db.select().from(passkeys);
    expect(row).toMatchObject({ userId: danId, name: 'Laptop', alg: -7, signCount: 0 });
    expect((await add(dan)).statusCode).toBe(409); // the same credential again
    const list = (await dan('GET', '/api/auth/passkeys')).json().items;
    expect(list).toEqual([
      { id: row!.id, name: 'Laptop', createdAt: expect.any(String), lastUsedAt: null },
    ]);
    expect((await dan('POST', '/api/auth/passkeys/options')).json().exclude).toEqual([u(key.id)]);
    expect((await anon('GET', '/api/auth/passkeys')).statusCode).toBe(401);
  });

  it('signs in with it: no password, no email', async () => {
    const r = await signIn();
    expect(r.statusCode).toBe(200);
    expect(r.json().user.email).toBe('dan@example.com');
    const cookie = String(r.headers['set-cookie']).split(';')[0]!;
    expect((await withHeaders({ ...H, cookie })('GET', '/api/auth/me')).statusCode).toBe(200);
    const made = (await t.db.select().from(sessions)).filter((s) => s.method === 'passkey');
    expect(made).toHaveLength(1);
    const [row] = await t.db.select().from(passkeys);
    expect(row!.signCount).toBe(1);
    expect(row!.lastUsedAt).not.toBeNull();
    const log = (await t.db.select().from(auditLog)).map((a) => a.summary);
    expect(log).toContain('dan@example.com logged in with the passkey "Laptop"');
  });

  it('refuses a replay, an unknown passkey, another origin, and a disabled user', async () => {
    const { challenge } = (await anon('POST', '/api/auth/passkey/options')).json();
    const g = key.get(challenge);
    const body = {
      id: u(key.id),
      clientDataJSON: u(g.clientDataJSON),
      authenticatorData: u(g.authenticatorData),
      signature: u(g.signature),
    };
    expect((await anon('POST', '/api/auth/passkey/login', body)).statusCode).toBe(200);
    expect((await anon('POST', '/api/auth/passkey/login', body)).statusCode).toBe(401);
    expect((await signIn(fakeAuthenticator())).statusCode).toBe(401);
    expect((await signIn(key, { origin: 'https://evil.test' })).statusCode).toBe(401);
    await t.db.update(users).set({ isActive: false }).where(eq(users.id, danId));
    expect((await signIn()).statusCode).toBe(401);
    await t.db.update(users).set({ isActive: true }).where(eq(users.id, danId));
    // Five failures from one address (the wrong password above was the first) block it (04 §2.2).
    expect((await signIn()).statusCode).toBe(429);
    resetLoginLimiter();
    expect((await signIn()).statusCode).toBe(200);
  });

  it('OpenID-only mode: a passkey is for admins, like the password', async () => {
    await t.db.update(users).set({ role: 'admin' }).where(eq(users.id, danId));
    expect((await signIn()).statusCode).toBe(200);
    await t.db.update(users).set({ role: 'user' }).where(eq(users.id, danId));
    await setSetting(t.db, 'auth.mode', 'oidc');
    const r = await signIn();
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('password_sign_in_off');
    await setSetting(t.db, 'auth.mode', 'password');
  });

  it('removes only your own; a removed passkey no longer signs in', async () => {
    await t.clearMustChange(ADMIN.email);
    const admin = withHeaders({ ...H, cookie: await t.login(ADMIN.email, ADMIN.password) });
    const [row] = await t.db.select().from(passkeys);
    expect((await admin('DELETE', `/api/auth/passkeys/${row!.id}`)).statusCode).toBe(404);
    expect((await dan('DELETE', `/api/auth/passkeys/${row!.id}`)).statusCode).toBe(200);
    expect((await signIn()).statusCode).toBe(401);
    const actions = (await t.db.select().from(auditLog))
      .filter((a) => a.entityType === 'passkey')
      .map((a) => a.action);
    expect(actions).toEqual(['create', 'delete']);

    // An admin's Reset password removes them too (15 §1).
    expect((await add(dan)).statusCode).toBe(200);
    expect((await admin('POST', `/api/users/${danId}/reset-password`)).statusCode).toBe(200);
    expect(await t.db.select().from(passkeys)).toHaveLength(0);
    expect((await signIn()).statusCode).toBe(401);
  });
});
