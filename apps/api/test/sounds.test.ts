// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T1: /api/sounds (04 §6): upload → wav + g722, play, rename, delete with references.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSetting } from '../src/services/settings.ts';
import { hasFfmpeg, silenceWav } from './audio.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb || !hasFfmpeg)('/api/sounds', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (
    method: string,
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => Promise<LightMyRequestResponse>;
  let id: string;
  const dir = () => t.app.config.SOUNDS_DIR;

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
  });
  afterAll(() => t?.close());

  it('upload converts to an 8 kHz wav plus a G.722 copy and measures it', async () => {
    const r = await req(
      'POST',
      '/api/sounds?name=Main%20greeting&filename=greeting.wav',
      silenceWav(3),
      { 'content-type': 'audio/wav' },
    );
    expect(r.statusCode, r.body).toBe(201);
    const dto = r.json();
    id = dto.id;
    expect(dto).toMatchObject({
      name: 'Main greeting',
      asteriskName: `custom/${id}`,
      originalFilename: 'greeting.wav',
    });
    expect(dto.durationMs).toBeGreaterThan(2900);
    expect(dto.durationMs).toBeLessThan(3100);
    expect(readFileSync(join(dir(), `${id}.wav`)).readUInt32LE(24)).toBe(8000);
    expect(existsSync(join(dir(), `${id}.g722`))).toBe(true);
  });

  it('rejects non-audio and a missing name', async () => {
    const junk = await req('POST', '/api/sounds?name=x', Buffer.from('nope'), {
      'content-type': 'audio/mpeg',
    });
    expect(junk.statusCode).toBe(400);
    expect(junk.json().error.message).toMatch(/isn't audio/);
    const noName = await req('POST', '/api/sounds', silenceWav(), { 'content-type': 'audio/wav' });
    expect(noName.statusCode).toBe(400);
  });

  it('lists, plays and renames', async () => {
    expect((await req('GET', '/api/sounds')).json().items.map((s: { id: string }) => s.id)).toEqual(
      [id],
    );
    const audio = await req('GET', `/api/sounds/${id}/audio`);
    expect(audio.statusCode).toBe(200);
    expect(audio.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    const r = await req('PATCH', `/api/sounds/${id}`, { name: 'Welcome' });
    expect(r.json().name).toBe('Welcome');
  });

  it('delete is refused while something plays it, then removes the files', async () => {
    await setSetting(t.db, 'recordings.announcementSoundId', id);
    const busy = await req('DELETE', `/api/sounds/${id}`);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.details.usedBy).toEqual([
      'the call recording notice (Settings → Recording)',
    ]);
    await setSetting(t.db, 'recordings.announcementSoundId', null);
    expect((await req('DELETE', `/api/sounds/${id}`)).statusCode).toBe(200);
    expect(existsSync(join(dir(), `${id}.wav`))).toBe(false);
    expect(existsSync(join(dir(), `${id}.g722`))).toBe(false);
    expect((await req('GET', `/api/sounds/${id}`)).statusCode).toBe(404);
  });
});
