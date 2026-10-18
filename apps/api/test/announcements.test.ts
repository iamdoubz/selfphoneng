// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T5: /api/announcements (03 §6.11).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { soundFiles } from '../src/db/schema.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('/api/announcements', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let dan: string;
  const sound = '44444444-4444-4444-8444-444444444447';
  let id: string;

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
    await t.db.insert(soundFiles).values({
      id: sound,
      name: 'Our hours',
      kind: 'prompt',
      source: 'upload',
      asteriskName: `custom/${sound}`,
      durationMs: 4000,
    });
  });
  afterAll(() => t?.close());

  it('plays the sound, then continues; shows up in the dialplan', async () => {
    const r = await req('POST', '/api/announcements', {
      name: 'Hours',
      soundId: sound,
      destination: { type: 'voicemail', id: dan },
    });
    expect(r.statusCode, r.body).toBe(201);
    id = r.json().id;
    expect(r.json()).toMatchObject({
      soundName: 'Our hours',
      destinationSummary: 'Voicemail of Dan Doe (101)',
    });
    await t.app.generator.apply({ trigger: 'test' });
    const conf = await readFile(join(t.genDir, 'extensions_selfphoneng.conf'), 'utf8');
    expect(conf).toContain(
      `[sp-ann-${id}]\nexten => s,1,Answer()\n same => n,Playback(custom/${sound})\n same => n,Goto(sp-vm-direct,101,1)`,
    );
  });

  it('refuses a missing sound, itself as destination; sound and announcement are protected', async () => {
    expect(
      (
        await req('POST', '/api/announcements', {
          name: 'X',
          soundId: '00000000-0000-4000-8000-000000000999',
          destination: { type: 'hangup' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await req('PATCH', `/api/announcements/${id}`, {
          destination: { type: 'announcement', id },
        })
      ).statusCode,
    ).toBe(400);
    const s = await req('DELETE', `/api/sounds/${sound}`);
    expect(s.json().error.details.usedBy).toEqual(['announcement Hours']);
    const ann2 = (
      await req('POST', '/api/announcements', {
        name: 'Before hours',
        soundId: sound,
        destination: { type: 'announcement', id },
      })
    ).json();
    expect(ann2.destinationSummary).toBe('Announcement Hours');
    expect((await req('DELETE', `/api/announcements/${id}`)).statusCode).toBe(409);
    expect((await req('DELETE', `/api/announcements/${ann2.id}`)).statusCode).toBe(200);
    expect((await req('DELETE', `/api/announcements/${id}`)).statusCode).toBe(200);
  });
});
