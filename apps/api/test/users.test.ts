// SPDX-License-Identifier: AGPL-3.0-or-later
// M1-T4 acceptance (API side): admins create/edit/delete users and every change is audited.
import { asc } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('users API', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let req: (
    method: string,
    url: string,
    payload?: unknown,
    cookie?: string,
  ) => Promise<LightMyRequestResponse>;
  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    admin = await t.login(ADMIN.email, ADMIN.password);
    req = (method, url, payload, cookie = admin) =>
      t.app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { ...H, cookie },
      });
  });
  afterAll(() => t?.close());

  let userId: string;

  it('creates a user with a one-time temporary password', async () => {
    const r = await req('POST', '/api/users', { email: 'ann@example.com', displayName: 'Ann Lee' });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.user).toMatchObject({
      email: 'ann@example.com',
      role: 'user',
      mustChangePassword: true,
    });
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.temporaryPassword).toMatch(/^[A-Za-z0-9]{16}$/);
    userId = body.user.id;
    const ann = await t.login('ann@example.com', body.temporaryPassword);
    const me = await t.app.inject({ url: '/api/auth/me', headers: { cookie: ann } });
    expect(me.json().user.mustChangePassword).toBe(true);
  });

  it('rejects duplicate emails (case-insensitive) and bad input', async () => {
    expect(
      (await req('POST', '/api/users', { email: 'ANN@example.com', displayName: 'x' })).statusCode,
    ).toBe(409);
    const bad = await req('POST', '/api/users', { email: 'nope', displayName: '' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_failed');
  });

  it('lists and fetches users', async () => {
    const list = (await req('GET', '/api/users')).json();
    expect(list.nextCursor).toBeNull();
    expect(list.items.map((u: { email: string }) => u.email).sort()).toEqual([
      ADMIN.email,
      'ann@example.com',
    ]);
    expect((await req('GET', `/api/users/${userId}`)).json().displayName).toBe('Ann Lee');
    expect((await req('GET', '/api/users/00000000-0000-4000-8000-000000000000')).statusCode).toBe(
      404,
    );
    expect((await req('GET', '/api/users/not-a-uuid')).statusCode).toBe(400);
  });

  it('edits a user', async () => {
    const r = await req('PATCH', `/api/users/${userId}`, {
      displayName: 'Ann B. Lee',
      role: 'admin',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ displayName: 'Ann B. Lee', role: 'admin' });
  });

  it('never leaves zero active admins', async () => {
    await req('PATCH', `/api/users/${userId}`, { role: 'user' });
    const me = (await req('GET', '/api/auth/me')).json().user.id;
    expect((await req('PATCH', `/api/users/${me}`, { role: 'user' })).statusCode).toBe(409);
    expect((await req('PATCH', `/api/users/${me}`, { isActive: false })).statusCode).toBe(409);
    expect((await req('DELETE', `/api/users/${me}`)).statusCode).toBe(409); // self-delete
  });

  it('resets a password and logs the user out', async () => {
    const r = await req('POST', `/api/users/${userId}/reset-password`);
    expect(r.statusCode).toBe(200);
    const ann = await t.login('ann@example.com', r.json().temporaryPassword);
    expect((await t.app.inject({ url: '/api/auth/me', headers: { cookie: ann } })).statusCode).toBe(
      200,
    );
  });

  it('non-admins get 403', async () => {
    await t.addUser('bob@example.com', 'bob-password-123');
    const bob = await t.login('bob@example.com', 'bob-password-123');
    expect((await req('GET', '/api/users', undefined, bob)).statusCode).toBe(403);
  });

  it('deletes a user', async () => {
    expect((await req('DELETE', `/api/users/${userId}`)).statusCode).toBe(200);
    expect((await req('GET', `/api/users/${userId}`)).statusCode).toBe(404);
  });

  it('audits every change, without secrets', async () => {
    const rows = await t.db.select().from(auditLog).orderBy(asc(auditLog.id));
    const userRows = rows.filter((r) => r.entityId === userId).map((r) => r.action);
    expect(userRows).toEqual(
      expect.arrayContaining(['create', 'update', 'reset_password', 'delete', 'login']),
    );
    const update = rows.find((r) => r.entityId === userId && r.action === 'update')!;
    expect(update.diff).toEqual({
      before: { displayName: 'Ann Lee', role: 'user' },
      after: { displayName: 'Ann B. Lee', role: 'admin' },
    });
    expect(JSON.stringify(rows)).not.toMatch(/\$argon2/);
  });
});
