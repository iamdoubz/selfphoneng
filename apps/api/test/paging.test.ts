// SPDX-License-Identifier: AGPL-3.0-or-later
// M8-T4: /api/paging-groups (03 §6.11, 04 §7.3).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('/api/paging-groups', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  const ext: Record<string, string> = {};
  let groupId: string;
  const dialplan = async () => {
    await t.app.generator.apply({ trigger: 'test' });
    return readFile(join(t.genDir, 'extensions_selfphoneng.conf'), 'utf8');
  };

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    req = (method, url, payload) =>
      t.app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { ...H, cookie },
      });
    for (const [number, name] of [
      ['102', 'Ann Lee'],
      ['101', 'Dan Doe'],
    ] as const)
      ext[number] = (await req('POST', '/api/extensions', { number, name })).json().id;
  });
  afterAll(() => t?.close());

  it('creates a group: desk phones only, auto-answer, busy phones skipped', async () => {
    const r = await req('POST', '/api/paging-groups', {
      number: '850',
      name: 'Warehouse',
      memberIds: [ext['102'], ext['101']],
    });
    expect(r.statusCode, r.body).toBe(201);
    groupId = r.json().id;
    expect(r.json()).toMatchObject({ duplex: false, memberIds: [ext['101'], ext['102']] });
    const d = await dialplan();
    expect(d).toContain(`exten => 850,1,Goto(sp-page-${groupId},s,1)`);
    expect(d).toContain('exten => s,1,Page(PJSIP/101&PJSIP/102,iqsb(sp-sub-autoanswer^s^1),30)');
  });

  it('checks the number and the members', async () => {
    const bad = (body: object) =>
      req('POST', '/api/paging-groups', { number: '851', name: 'X', ...body });
    expect((await bad({ number: '800' })).statusCode).toBe(400); // conference range
    expect((await bad({ number: '850' })).statusCode).toBe(409);
    expect((await bad({ memberIds: [ext['101'], ext['101']] })).statusCode).toBe(400);
    expect((await bad({ memberIds: ['00000000-0000-4000-8000-000000000000'] })).statusCode).toBe(
      400,
    );
  });

  it('two-way and fewer members; delete removes it from the dialplan', async () => {
    const r = await req('PATCH', `/api/paging-groups/${groupId}`, {
      duplex: true,
      memberIds: [ext['102']],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(await dialplan()).toContain(
      'exten => s,1,Page(PJSIP/102,diqsb(sp-sub-autoanswer^s^1),30)',
    );
    expect((await req('DELETE', `/api/paging-groups/${groupId}`)).statusCode).toBe(200);
    expect(await dialplan()).not.toContain('sp-page-');
  });
});
