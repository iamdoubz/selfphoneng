// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T2: /api/ring-groups (03 §6.7, 04 §7.3).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('/api/ring-groups', () => {
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
    for (const [n, name] of [
      ['101', 'Dan Doe'],
      ['102', 'Sue Smith'],
    ] as const)
      ext[n] = (await req('POST', '/api/extensions', { number: n, name })).json().id;
  });
  afterAll(() => t?.close());

  it('creates a group with ordered members; the dialplan rings them', async () => {
    const r = await req('POST', '/api/ring-groups', {
      number: '500',
      name: 'Sales',
      memberIds: [ext['102'], ext['101']],
      noAnswerDestination: { type: 'voicemail', id: ext['101'] },
    });
    expect(r.statusCode, r.body).toBe(201);
    groupId = r.json().id;
    expect(r.json()).toMatchObject({
      strategy: 'ringall',
      ringSeconds: 25,
      memberIds: [ext['102'], ext['101']],
      noAnswerSummary: 'Voicemail of Dan Doe (101)',
    });
    const conf = await dialplan();
    expect(conf).toContain(`exten => 500,1,Goto(sp-rg-${groupId},s,1)`);
    expect(conf).toContain('Dial(Local/102@sp-rg-member&Local/101@sp-rg-member,25,t)');
  });

  it('checks the number, members and destination', async () => {
    const bad = (body: object) =>
      req('POST', '/api/ring-groups', {
        number: '501',
        name: 'X',
        noAnswerDestination: { type: 'hangup' },
        ...body,
      });
    expect((await bad({ number: '101' })).statusCode).toBe(400); // outside 500–549
    expect((await bad({ number: '500' })).statusCode).toBe(409);
    expect((await bad({ memberIds: [ext['101'], ext['101']] })).statusCode).toBe(400);
    expect((await bad({ memberIds: ['00000000-0000-4000-8000-000000000999'] })).statusCode).toBe(
      400,
    );
    expect(
      (
        await bad({
          noAnswerDestination: { type: 'ivr', id: '00000000-0000-4000-8000-000000000999' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await req('PATCH', `/api/ring-groups/${groupId}`, {
          noAnswerDestination: { type: 'ring_group', id: groupId },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('hunt: one member at a time; reorder via PATCH', async () => {
    const r = await req('PATCH', `/api/ring-groups/${groupId}`, {
      strategy: 'hunt',
      ringSeconds: 15,
      memberIds: [ext['101'], ext['102']],
    });
    expect(r.statusCode, r.body).toBe(200);
    const conf = await dialplan();
    expect(conf.indexOf('Dial(Local/101@sp-rg-member,15,t)')).toBeLessThan(
      conf.indexOf('Dial(Local/102@sp-rg-member,15,t)'),
    );
  });

  it('a phone number can point at it; delete is refused while it does', async () => {
    const trunkId = (
      await req('POST', '/api/trunks', {
        name: 'voip.ms',
        serverHost: '127.0.0.1',
        username: '123456_pbx',
        password: 'pw',
      })
    ).json().id;
    const did = await req('POST', '/api/dids', {
      number: '3125551234',
      trunkId,
      destination: { type: 'ring_group', id: groupId },
    });
    expect(did.json().destinationSummary).toBe('Ring group Sales (500)');
    expect(await dialplan()).toContain(`Goto(sp-rg-${groupId},s,1)`);
    const busy = await req('DELETE', `/api/ring-groups/${groupId}`);
    expect(busy.statusCode).toBe(409);
    await req('PATCH', `/api/dids/${did.json().id}`, { destination: { type: 'hangup' } });
    expect((await req('DELETE', `/api/ring-groups/${groupId}`)).statusCode).toBe(200);
    expect(await dialplan()).not.toContain(`sp-rg-${groupId}`);
  });
});
