// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T1: two-step sign-in for admins (08 §2.4).
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stepAt, totpCode } from '../src/auth/totp.ts';
import { resetLoginLimiter } from '../src/auth/login-limiter.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('two-step sign-in', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let cookie: string;
  let secret: string;
  let recovery: string[];
  const req = (method: string, url: string, payload?: unknown, c = cookie) =>
    t.app.inject({
      method: method as 'GET',
      url,
      payload: payload as object,
      headers: { ...H, cookie: c },
    });
  const login = (totp?: string): Promise<LightMyRequestResponse> =>
    t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { email: ADMIN.email, password: ADMIN.password, ...(totp ? { totp } : {}) },
    });

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    cookie = await t.login(ADMIN.email, ADMIN.password);
  });
  afterAll(() => t?.close());
  beforeEach(() => resetLoginLimiter());

  it('turns on with a code from the scanned secret; gives 10 recovery codes once', async () => {
    expect((await req('GET', '/api/auth/totp')).json()).toEqual({
      enabled: false,
      recoveryCodesLeft: 0,
    });
    const setup = (await req('POST', '/api/auth/totp/setup', {})).json();
    secret = setup.secret;
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/.+\?secret=[A-Z2-7]{32}&issuer=/);
    expect(setup.qr).toMatch(/^data:image\/png;base64,/);
    const bad = await req('POST', '/api/auth/totp/enable', { secret, code: '000000' });
    expect(bad.statusCode).toBe(400);
    const ok = await req('POST', '/api/auth/totp/enable', {
      secret,
      code: totpCode(secret, stepAt()),
    });
    expect(ok.statusCode, ok.body).toBe(200);
    recovery = ok.json().recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect((await req('GET', '/api/auth/totp')).json()).toEqual({
      enabled: true,
      recoveryCodesLeft: 10,
    });
    expect(
      (await req('POST', '/api/auth/totp/enable', { secret, code: '123456' })).statusCode,
    ).toBe(409);
  });

  it('login asks for the code after the password; a code works once', async () => {
    const noCode = await login();
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().error.code).toBe('totp_required');
    expect(noCode.headers['set-cookie']).toBeUndefined();
    expect((await login('000000')).json().error.code).toBe('totp_invalid');
    // The step used to turn it on is spent; the next one (within the ±1 window) works, once.
    const next = totpCode(secret, stepAt() + 1);
    expect((await login(next)).statusCode).toBe(200);
    expect((await login(next)).json().error.code).toBe('totp_invalid');
    // A wrong password never reveals that a code is needed.
    const wrongPw = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { email: ADMIN.email, password: 'nope-nope-nope' },
    });
    expect(wrongPw.json().error.code).toBe('unauthorized');
  });

  it('a recovery code works once, typed any way', async () => {
    const code = recovery[0]!;
    expect((await login(code.toUpperCase())).statusCode).toBe(200);
    expect((await login(code)).statusCode).toBe(401);
    expect((await req('GET', '/api/auth/totp')).json().recoveryCodesLeft).toBe(9);
  });

  it('users list shows it; another admin can turn it off; off needs the password', async () => {
    const list = (await req('GET', '/api/users')).json().items;
    expect(list.find((u: { email: string }) => u.email === ADMIN.email).twoStep).toBe(true);
    expect((await req('POST', '/api/auth/totp/disable', { password: 'wrong' })).statusCode).toBe(
      400,
    );
    const off = await req('POST', '/api/auth/totp/disable', { password: ADMIN.password });
    expect(off.statusCode).toBe(200);
    expect((await login()).statusCode).toBe(200);
    // the admin reset (for a lost phone)
    const me = (await req('GET', '/api/auth/me')).json().user;
    expect((await req('POST', `/api/users/${me.id}/reset-two-step`, {})).statusCode).toBe(200);
  });

  it('is for admins only', async () => {
    cookie = await t.login(ADMIN.email, ADMIN.password); // the reset ended my sessions
    const u = (
      await req('POST', '/api/users', { email: 'plain@example.com', displayName: 'Plain' })
    ).json();
    await t.clearMustChange('plain@example.com');
    const plain = await t.login('plain@example.com', u.temporaryPassword);
    expect((await req('POST', '/api/auth/totp/setup', {}, plain)).statusCode).toBe(403);
  });
});
