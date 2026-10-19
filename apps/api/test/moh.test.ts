// SPDX-License-Identifier: AGPL-3.0-or-later
// M8-T5: /api/moh-classes (03 §8, 04 §6): classes, their files, and who may use them.
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasFfmpeg, silenceWav } from './audio.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb || !hasFfmpeg)('/api/moh-classes', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (
    method: string,
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => Promise<LightMyRequestResponse>;
  let classId: string;
  let fileId: string;
  let extId: string;
  const mohDir = () => t.app.config.MOH_DIR;
  const conf = async () => {
    await t.app.generator.apply({ trigger: 'test' });
    return readFile(join(t.genDir, 'musiconhold_selfphoneng.conf'), 'utf8');
  };

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    req = (method, url, payload, headers) =>
      t.app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { ...H, cookie, ...headers },
      });
    extId = (await req('POST', '/api/extensions', { number: '101', name: 'Dan Doe' })).json().id;
  });
  afterAll(() => t?.close());

  it('creates a class: its folder; no section until it has music', async () => {
    const r = await req('POST', '/api/moh-classes', { name: 'sales-jazz' });
    expect(r.statusCode, r.body).toBe(201);
    classId = r.json().id;
    expect(existsSync(join(mohDir(), 'sales-jazz'))).toBe(true);
    expect(await conf()).not.toContain('sales-jazz'); // empty: Asterisk falls back to default
    expect((await req('POST', '/api/moh-classes', { name: 'sales-jazz' })).statusCode).toBe(409);
    for (const name of ['default', 'Sales', '../x', 'a b'])
      expect((await req('POST', '/api/moh-classes', { name })).statusCode, name).toBe(400);
  });

  it('adds music: an 8 kHz wav in the folder, playable, listed', async () => {
    const r = await req(
      'POST',
      `/api/moh-classes/${classId}/files?name=Smooth&filename=smooth.wav`,
      silenceWav(),
      { 'content-type': 'audio/wav' },
    );
    expect(r.statusCode, r.body).toBe(201);
    fileId = r.json().files[0].id;
    expect(r.json().files[0]).toMatchObject({ name: 'Smooth', originalFilename: 'smooth.wav' });
    const wav = join(mohDir(), 'sales-jazz', `${fileId}.wav`);
    expect(readFileSync(wav).readUInt32LE(24)).toBe(8000);
    expect(await conf()).toContain(
      '[sales-jazz]\nmode = files\ndirectory = /var/lib/asterisk/moh/sales-jazz\nsort = random',
    );
    const audio = await req('GET', `/api/moh-classes/${classId}/files/${fileId}/audio`);
    expect(audio.statusCode).toBe(200);
    // not a prompt: the sounds list and pickers don't show it
    expect((await req('GET', '/api/sounds')).json().items).toEqual([]);
    const bad = await req('POST', `/api/moh-classes/${classId}/files?name=X`, Buffer.from('nope'), {
      'content-type': 'audio/wav',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('users and queues may pick only classes that exist; delete is refused while used', async () => {
    const pick = (mohClass: string) => req('PATCH', `/api/extensions/${extId}`, { mohClass });
    expect((await pick('nope')).statusCode).toBe(400);
    expect((await pick('sales-jazz')).statusCode).toBe(200);
    const queue = await req('POST', '/api/queues', {
      number: '550',
      name: 'Support',
      mohClass: 'nope',
      timeoutDestination: { type: 'hangup' },
    });
    expect(queue.statusCode).toBe(400);
    const del = await req('DELETE', `/api/moh-classes/${classId}`);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.details.usedBy).toEqual(['extension 101']);
    expect((await pick('default')).statusCode).toBe(200);
  });

  it('removing a file and the class removes them from disk and config', async () => {
    expect((await req('DELETE', `/api/moh-classes/${classId}/files/${fileId}`)).statusCode).toBe(
      200,
    );
    expect(existsSync(join(mohDir(), 'sales-jazz', `${fileId}.wav`))).toBe(false);
    expect(await conf()).not.toContain('sales-jazz');
    expect((await req('DELETE', `/api/moh-classes/${classId}`)).statusCode).toBe(200);
    expect(existsSync(join(mohDir(), 'sales-jazz'))).toBe(false);
    expect(await conf()).not.toContain('sales-jazz');
  });
});
