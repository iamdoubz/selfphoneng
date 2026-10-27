// SPDX-License-Identifier: AGPL-3.0-or-later
// MB1: pairing the mobile app and its device tokens (13 §2, §4).
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, mobileDevices, users } from '../src/db/schema.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('mobile app pairing', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  type Req = (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let admin: Req;
  let dan: Req;
  let danId: string;
  const withHeaders =
    (headers: Record<string, string>): Req =>
    (method, url, payload) =>
      t.app.inject({ method: method as 'GET', url, payload: payload as object, headers });
  const bearer = (token: string) => withHeaders({ authorization: `Bearer ${token}` });
  // The app sends X-Requested-With on its one call without a token (CSRF hook, 04 §2.2).
  const anon = withHeaders(H);
  const pair = (code: string, name = 'Pixel 9') =>
    anon('POST', '/api/mobile/pair', { code, name, platform: 'android' });

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    admin = withHeaders({ ...H, cookie: await t.login(ADMIN.email, ADMIN.password) });
    danId = (await t.addUser('dan@example.com', 'dan-password-123')).id;
    dan = withHeaders({ ...H, cookie: await t.login('dan@example.com', 'dan-password-123') });
    // GET /api/me needs an extension.
    for (const [number, userId] of [
      ['101', danId],
      ['102', (await t.db.select().from(users).where(eq(users.email, ADMIN.email)))[0]!.id],
    ])
      await admin('POST', '/api/extensions', { number, name: `Ext ${number}`, userId });
  });
  afterAll(() => t?.close());

  let token: string;
  let deviceId: string;

  it('pairs a phone once with a code from the web page', async () => {
    const r = await dan('POST', '/api/me/mobile-devices/pair');
    expect(r.statusCode).toBe(200);
    const c = r.json();
    expect(c.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
    expect(c.server).toBe('https://pbx.test');
    expect(c.link).toBe(
      `selfphoneng://pair?server=${encodeURIComponent('https://pbx.test')}&code=${c.code}`,
    );
    expect(c.qr).toMatch(/^data:image\/png;base64,/);
    expect(new Date(c.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);

    // Typed by hand: lower case and spaces are fine.
    const typed = `${c.code.slice(0, 4)} ${c.code.slice(4)}`.toLowerCase();
    const p = await pair(typed);
    expect(p.statusCode).toBe(200);
    expect(p.json().user).toEqual({ name: expect.any(String), email: 'dan@example.com' });
    token = p.json().token;
    expect(token).toMatch(/^spm_[A-Za-z0-9]{40}$/);

    expect((await pair(c.code)).json().error.code).toBe('pair_code_invalid'); // used
    const rows = await t.db.select().from(mobileDevices);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toContain(token.slice(4)); // stored hashed
    expect(rows[0]!.pairCodeHash).toBeNull();
    deviceId = rows[0]!.id;
  });

  it('the device token acts as its user', async () => {
    const me = bearer(token);
    expect((await me('GET', '/api/me')).statusCode).toBe(200);
    // No X-Requested-With needed with a Bearer token.
    expect((await me('PATCH', '/api/me', { dnd: true })).statusCode).toBe(200);
    const list = (await me('GET', '/api/me/mobile-devices')).json().items;
    expect(list).toEqual([
      {
        id: deviceId,
        name: 'Pixel 9',
        platform: 'android',
        tokenPrefix: token.slice(0, 8),
        createdAt: expect.any(String),
        lastUsedAt: expect.any(String),
        current: true,
      },
    ]);
    expect((await dan('GET', '/api/me/mobile-devices')).json().items[0].current).toBe(false);
    // A phone can't make itself a spare.
    expect((await me('POST', '/api/me/mobile-devices/pair')).statusCode).toBe(403);
    expect((await bearer(`spm_${'x'.repeat(40)}`)('GET', '/api/me')).statusCode).toBe(401);
  });

  it("an admin's phone is not an admin", async () => {
    const code = (await admin('POST', '/api/me/mobile-devices/pair')).json().code;
    const phone = bearer((await pair(code, 'iPhone')).json().token);
    expect((await phone('GET', '/api/me')).statusCode).toBe(200);
    expect((await phone('GET', '/api/users')).statusCode).toBe(403);
    expect((await phone('GET', '/api/api-tokens')).statusCode).toBe(403);
    expect((await admin('GET', '/api/users')).statusCode).toBe(200);
  });

  it('refuses expired codes, bad input, and replaces an unused code', async () => {
    const first = (await dan('POST', '/api/me/mobile-devices/pair')).json().code;
    const second = (await dan('POST', '/api/me/mobile-devices/pair')).json().code;
    expect((await pair(first)).statusCode).toBe(404); // replaced
    await t.db
      .update(mobileDevices)
      .set({ pairExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(mobileDevices.userId, danId));
    expect((await pair(second)).json().error.code).toBe('pair_code_invalid');
    const bad = await anon('POST', '/api/mobile/pair', {
      code: second,
      name: 'x',
      platform: 'windows',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('a disabled user loses their phones and can’t pair one', async () => {
    const code = (await dan('POST', '/api/me/mobile-devices/pair')).json().code;
    await t.db.update(users).set({ isActive: false }).where(eq(users.id, danId));
    expect((await bearer(token)('GET', '/api/me')).statusCode).toBe(401);
    expect((await pair(code)).statusCode).toBe(404);
    await t.db.update(users).set({ isActive: true }).where(eq(users.id, danId));
    expect((await bearer(token)('GET', '/api/me')).statusCode).toBe(200);
  });

  it('removing a device ends its token; only your own', async () => {
    const adminPhone = (await t.db.select().from(mobileDevices)).find((d) => d.name === 'iPhone')!;
    expect(
      (await bearer(token)('DELETE', `/api/me/mobile-devices/${adminPhone.id}`)).statusCode,
    ).toBe(404);
    expect((await bearer(token)('DELETE', `/api/me/mobile-devices/${deviceId}`)).statusCode).toBe(
      200,
    );
    expect((await bearer(token)('GET', '/api/me')).statusCode).toBe(401);
    const actions = (await t.db.select().from(auditLog))
      .filter((a) => a.entityType === 'mobile_device')
      .map((a) => a.action);
    expect(actions).toContain('create');
    expect(actions).toContain('delete');
  });

  it('changing the password removes every paired phone', async () => {
    const code = (await dan('POST', '/api/me/mobile-devices/pair')).json().code;
    const phone = bearer((await pair(code)).json().token);
    expect((await phone('GET', '/api/me')).statusCode).toBe(200);
    const r = await dan('POST', '/api/auth/change-password', {
      currentPassword: 'dan-password-123',
      newPassword: 'a-new-dan-password-456',
    });
    expect(r.statusCode).toBe(200);
    expect((await phone('GET', '/api/me')).statusCode).toBe(401);
    expect((await dan('GET', '/api/me/mobile-devices')).json().items).toEqual([]);
  });
});
