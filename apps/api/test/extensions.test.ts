// SPDX-License-Identifier: AGPL-3.0-or-later
// M2-T5: numbering rules, extensions CRUD, credentials, and every change reaching the generator.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, extensions, userRuntimeState } from '../src/db/schema.ts';
import { decrypt } from '../src/crypto/secrets.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('extensions API', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let req: (
    method: string,
    url: string,
    payload?: unknown,
    cookie?: string,
  ) => Promise<LightMyRequestResponse>;
  const pjsip = () => readFileSync(join(t.genDir, 'pjsip_selfphoneng.conf'), 'utf8');
  const settle = () => new Promise((r) => setTimeout(r, 150)); // debounce is 20 ms in tests
  let userId: string;
  let extId: string;

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
    userId = (await t.addUser('dan@example.com', 'dan-password-123')).id;
  });
  afterAll(() => t?.close());

  it('suggests the lowest free number in the users range', async () => {
    expect((await req('GET', '/api/numbering/next?kind=user')).json()).toEqual({ number: '100' });
    expect((await req('GET', '/api/numbering/next?kind=queue')).json()).toEqual({ number: '550' });
    expect((await req('GET', '/api/numbering/next?kind=nope')).statusCode).toBe(400);
  });

  it('creating an extension generates secrets, a runtime row, and PJSIP config within the debounce', async () => {
    const r = await req('POST', '/api/extensions', { number: '101', name: 'Dan Doe', userId });
    expect(r.statusCode).toBe(201);
    const dto = r.json();
    extId = dto.id;
    expect(dto).toMatchObject({ number: '101', userId, webrtcEnabled: true, ringSeconds: 25 });
    expect(Object.keys(dto).filter((k) => /Enc$|password|Pin$/i.test(k))).toEqual([]);

    const [row] = await t.db.select().from(extensions).where(eq(extensions.id, extId));
    expect(decrypt(row!.sipPasswordEnc)).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(decrypt(row!.voicemailPinEnc)).toMatch(/^\d{6}$/);
    expect(await t.db.select().from(userRuntimeState)).toHaveLength(1);

    await settle();
    expect(pjsip()).toContain('[101]\ntype = endpoint');
    expect(pjsip()).toContain('[101-web]\ntype = endpoint');
    expect(t.ami.commands).toContain('module reload res_pjsip.so');
  });

  it('enforces the numbering rules', async () => {
    const make = (number: string, extra = {}) =>
      req('POST', '/api/extensions', { number, name: 'X', ...extra });
    expect((await make('211')).json().error.message).toMatch(/reserved/);
    expect((await make('600')).json().error.message).toMatch(/from 100 to 499/);
    expect((await make('12')).statusCode).toBe(400);
    expect((await make('710')).statusCode).toBe(400); // outside the users range anyway
    const dup = await make('101');
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toMatch(/extension "Dan Doe"/);
    expect((await make('102', { userId })).json().error.message).toMatch(
      /already has extension 101/,
    );
    expect((await req('GET', '/api/numbering/next?kind=user')).json().number).toBe('100');
  });

  it('shows the extension on the user', async () => {
    const users = (await req('GET', '/api/users')).json().items;
    expect(users.find((u: { id: string }) => u.id === userId).extension).toEqual({
      id: extId,
      number: '101',
    });
  });

  it('reveals SIP credentials only on request, and audits it', async () => {
    const r = await req('GET', `/api/extensions/${extId}/sip-credentials`);
    expect(r.json()).toMatchObject({
      server: 'pbx.test',
      port: 5060,
      username: '101',
      webUsername: '101-web',
    });
    expect(pjsip()).toContain(`password = ${r.json().password}`);
    const [a] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'reveal_sip_credentials'));
    expect(a).toMatchObject({ entityId: extId });
    expect(JSON.stringify(a)).not.toContain(r.json().password);
  });

  it('regenerates the SIP password and the config follows', async () => {
    const old = (await req('GET', `/api/extensions/${extId}/sip-credentials`)).json().password;
    expect((await req('POST', `/api/extensions/${extId}/regenerate-sip-password`)).statusCode).toBe(
      200,
    );
    await settle();
    const now = (await req('GET', `/api/extensions/${extId}/sip-credentials`)).json().password;
    expect(now).not.toBe(old);
    expect(pjsip()).toContain(`password = ${now}`);
    expect(pjsip()).not.toContain(old);
  });

  it('updates fields, renumbers, and rejects trivial PINs', async () => {
    expect(
      (await req('PATCH', `/api/extensions/${extId}`, { voicemailPin: '101101' })).statusCode,
    ).toBe(400);
    expect(
      (await req('PATCH', `/api/extensions/${extId}`, { voicemailPin: '123456' })).statusCode,
    ).toBe(400);
    expect(
      (await req('PATCH', `/api/extensions/${extId}`, { pickupGroup: 'Sales!' })).statusCode,
    ).toBe(400);
    const r = await req('PATCH', `/api/extensions/${extId}`, {
      number: '102',
      webrtcEnabled: false,
      pickupGroup: 'sales',
      voicemailPin: '482913',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ number: '102', webrtcEnabled: false, pickupGroup: 'sales' });
    await settle();
    expect(pjsip()).toContain('[102]\ntype = endpoint');
    expect(pjsip()).not.toContain('[101]');
    expect(pjsip()).not.toContain('102-web');
    expect(pjsip()).toContain('named_pickup_group = sales');
  });

  it('non-admins get 403', async () => {
    await t.addUser('bob@example.com', 'bob-password-123');
    const bob = await t.login('bob@example.com', 'bob-password-123');
    expect((await req('GET', '/api/extensions', undefined, bob)).statusCode).toBe(403);
    expect(
      (await req('GET', `/api/extensions/${extId}/sip-credentials`, undefined, bob)).statusCode,
    ).toBe(403);
  });

  it('deletes the extension and removes it from the config', async () => {
    expect((await req('DELETE', `/api/extensions/${extId}`)).statusCode).toBe(200);
    await settle();
    expect(pjsip()).not.toContain('[102]');
    const actions = (
      await t.db
        .select({ a: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.entityId, extId))
        .orderBy(asc(auditLog.id))
    ).map((r) => r.a);
    expect(actions).toEqual([
      'create',
      'reveal_sip_credentials',
      'reveal_sip_credentials',
      'regenerate_sip_password',
      'reveal_sip_credentials',
      'update',
      'delete',
    ]);
  });
});
