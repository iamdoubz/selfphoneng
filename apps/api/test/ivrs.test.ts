// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T3: /api/ivrs (03 §6.9, 04 §7.3).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { soundFiles } from '../src/db/schema.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('/api/ivrs', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let dan: string;
  let greeting: string;
  let ivrId: string;
  const dialplan = async () => {
    await t.app.generator.apply({ trigger: 'test' });
    return readFile(join(t.genDir, 'extensions_selfphoneng.conf'), 'utf8');
  };
  const base = () => ({
    number: '600',
    name: 'Main menu',
    greetingSoundId: greeting,
    timeoutDestination: { type: 'voicemail', id: dan },
    invalidDestination: { type: 'hangup' },
  });

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
    dan = (await req('POST', '/api/extensions', { number: '101', name: 'Dan Doe' })).json().id;
    const id = '44444444-4444-4444-8444-444444444444';
    await t.db.insert(soundFiles).values({
      id,
      name: 'Welcome',
      kind: 'prompt',
      source: 'upload',
      asteriskName: `custom/${id}`,
      durationMs: 3000,
    });
    greeting = id;
  });
  afterAll(() => t?.close());

  it('creates a menu; the dialplan plays the greeting and maps the keys', async () => {
    const r = await req('POST', '/api/ivrs', {
      ...base(),
      options: [
        { digit: '1', destination: { type: 'user', id: dan } },
        { digit: '#', destination: { type: 'voicemail', id: dan } },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    ivrId = r.json().id;
    expect(r.json()).toMatchObject({
      timeoutSeconds: 5,
      maxRetries: 3,
      allowDirectDial: true,
      options: [
        { digit: '#', summary: 'Voicemail of Dan Doe (101)' },
        { digit: '1', summary: 'Ring Dan Doe (101)' },
      ],
    });
    const conf = await dialplan();
    expect(conf).toContain(`exten => 600,1,Goto(sp-ivr-${ivrId},s,1)`);
    expect(conf).toContain(`Background(custom/${greeting})`);
    expect(conf).toContain('exten => 1,1,Goto(sp-local-numbers,101,1)');
    expect(conf).toContain('exten => #,1,Goto(sp-vm-direct,101,1)');
  });

  it('validates keys, sounds, numbers and destinations', async () => {
    const post = (body: object) => req('POST', '/api/ivrs', { ...base(), number: '601', ...body });
    const missing = '00000000-0000-4000-8000-000000000999';
    expect((await post({ number: '600' })).statusCode).toBe(409);
    expect((await post({ number: '1234567' })).statusCode).toBe(400);
    // A one-digit number and a menu key (direct dialing on) can't be the same, either way round.
    const one = await req('POST', '/api/extensions', { number: '1', name: 'X' });
    expect(one.statusCode).toBe(409);
    expect(one.json().error.message).toMatch(/menu key of the digital receptionist "Main menu"/);
    const four = await req('POST', '/api/extensions', { number: '4', name: 'Four' });
    expect(four.statusCode, four.body).toBe(201);
    const clash = await post({ options: [{ digit: '4', destination: { type: 'hangup' } }] });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message).toMatch(/Key 4 is also the number of extension "Four"/);
    const noDial = await post({
      allowDirectDial: false,
      number: '602',
      options: [{ digit: '4', destination: { type: 'hangup' } }],
    });
    expect(noDial.statusCode).toBe(201);
    await req('DELETE', `/api/ivrs/${noDial.json().id}`);
    await req('DELETE', `/api/extensions/${four.json().id}`);
    expect((await post({ greetingSoundId: missing })).statusCode).toBe(400);
    const twice = await post({
      options: [
        { digit: '1', destination: { type: 'hangup' } },
        { digit: '1', destination: { type: 'hangup' } },
      ],
    });
    expect(twice.statusCode).toBe(400);
    expect(
      (await post({ options: [{ digit: 'A', destination: { type: 'hangup' } }] })).statusCode,
    ).toBe(400);
    expect(
      (await post({ options: [{ digit: '2', destination: { type: 'ring_group', id: missing } }] }))
        .statusCode,
    ).toBe(400);
  });

  it('"press 9 to hear this again" points at itself, and the menu can still be deleted', async () => {
    const r = await req('PATCH', `/api/ivrs/${ivrId}`, {
      options: [{ digit: '9', destination: { type: 'ivr', id: ivrId } }],
      allowDirectDial: false,
    });
    expect(r.statusCode, r.body).toBe(200);
    const conf = await dialplan();
    expect(conf).toContain(`exten => 9,1,Goto(sp-ivr-${ivrId},s,1)`);
    expect(conf).not.toContain('include => sp-local-numbers\nexten => s,1,Answer()');
  });

  it('the greeting sound and the menu are protected while in use', async () => {
    const sound = await req('DELETE', `/api/sounds/${greeting}`);
    expect(sound.statusCode).toBe(409);
    expect(sound.json().error.details.usedBy).toEqual(['digital receptionist Main menu']);
    const trunkId = (
      await req('POST', '/api/trunks', {
        name: 'voip.ms',
        serverHost: '127.0.0.1',
        username: '123456_pbx',
        password: 'pw',
      })
    ).json().id;
    const did = (
      await req('POST', '/api/dids', {
        number: '3125551234',
        trunkId,
        destination: { type: 'ivr', id: ivrId },
      })
    ).json();
    expect(did.destinationSummary).toBe('Digital receptionist Main menu (600)');
    expect((await req('DELETE', `/api/ivrs/${ivrId}`)).statusCode).toBe(409);
    // The refused delete must not have dropped its options.
    expect((await req('GET', `/api/ivrs/${ivrId}`)).json().options).toHaveLength(1);
    await req('PATCH', `/api/dids/${did.id}`, { destination: { type: 'hangup' } });
    expect((await req('DELETE', `/api/ivrs/${ivrId}`)).statusCode).toBe(200);
    expect(await dialplan()).not.toContain(`sp-ivr-${ivrId}`);
  });
});
