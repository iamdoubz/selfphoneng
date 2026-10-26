// SPDX-License-Identifier: AGPL-3.0-or-later
// 08 §2.4: every route is rate limited per client IP, Test buttons more, and a signed-in
// person's password asked again counts like a sign-in.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetLoginLimiter } from '../src/auth/login-limiter.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('rate limits (08 §2.4)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  beforeAll(async () => {
    t = await createTestApp(undefined, { RATE_LIMIT_PER_MINUTE: '30' });
    await t.clearMustChange(ADMIN.email);
    admin = await t.login(ADMIN.email, ADMIN.password);
  });
  afterAll(() => t?.close());

  it('Test buttons: 10 a minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++)
      codes.push(
        (
          await t.app.inject({
            method: 'POST',
            url: '/api/settings/smtp/test',
            headers: { ...H, cookie: admin },
            payload: {},
          })
        ).statusCode,
      );
    expect(codes.slice(0, 10)).not.toContain(429);
    expect(codes[10]).toBe(429);
  });

  it('a password asked again counts like a sign-in: guessing it is stopped', async () => {
    resetLoginLimiter();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push(
        (
          await t.app.inject({
            method: 'POST',
            url: '/api/auth/change-password',
            headers: { ...H, cookie: admin },
            payload: { currentPassword: `guess-${i}-wrong`, newPassword: 'another-password-1' },
          })
        ).statusCode,
      );
    expect(codes.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(codes[5]).toBe(429);
    resetLoginLimiter();
  });

  it('/prov keeps its own limits (07 §2), outside the global one', async () => {
    const prov = await t.app.inject({ url: '/prov/001565000000.cfg' });
    expect(prov.headers['x-ratelimit-limit']).toBeUndefined();
    const api = await t.app.inject({ url: '/api/auth/methods' });
    expect(api.headers['x-ratelimit-limit']).toBe('30');
  });

  it('every other route: the global limit per IP, as a 429 rate_limited', async () => {
    let r;
    for (let i = 0; i < 40; i++) {
      r = await t.app.inject({ url: '/api/auth/methods' });
      if (r.statusCode === 429) break;
    }
    expect(r!.statusCode).toBe(429);
    expect(r!.json().error.code).toBe('rate_limited');
  });
});
