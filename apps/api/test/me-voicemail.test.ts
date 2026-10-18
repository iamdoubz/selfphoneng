// SPDX-License-Identifier: AGPL-3.0-or-later
// M4-T3: /api/me/voicemail and /api/me/greetings (04 §5.6, §7.3).
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** 8 kHz mono silence as a wav file. */
function silenceWav(seconds = 1) {
  const data = Buffer.alloc(8000 * 2 * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

type Inject = (
  method: string,
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
) => Promise<LightMyRequestResponse>;

describe.skipIf(!hasTestDb)('/api/me/voicemail and greetings', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let dan: Inject;
  let eve: Inject;
  const box = () => join(t.spoolDir, 'default', '101');
  const leave = (msgId: string, callerid: string) => {
    mkdirSync(join(box(), 'INBOX'), { recursive: true });
    writeFileSync(join(box(), 'INBOX', 'msg0000.wav'), silenceWav());
    writeFileSync(
      join(box(), 'INBOX', 'msg0000.txt'),
      `[message]\ncallerid=${callerid}\norigtime=1792300385\nmsg_id=${msgId}\nduration=1\n`,
    );
  };

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const admin = await t.login(ADMIN.email, ADMIN.password);
    const danId = (await t.addUser('dan@example.com', 'dan-password-123')).id;
    await t.addUser('eve@example.com', 'eve-password-123');
    await t.app.inject({
      method: 'POST',
      url: '/api/extensions',
      headers: { ...H, cookie: admin },
      payload: { number: '101', name: 'Dan Doe', userId: danId },
    });
    const as =
      (cookie: string): Inject =>
      (method, url, payload, headers) =>
        t.app.inject({
          method: method as 'GET',
          url,
          payload: payload as object,
          headers: { ...H, cookie, ...headers },
        });
    dan = as(await t.login('dan@example.com', 'dan-password-123'));
    eve = as(await t.login('eve@example.com', 'eve-password-123'));
    // Asterisk's side of VoicemailMove/VoicemailRemove, on disk (one message, msg0000).
    t.ami.action = async function (f: Record<string, string>) {
      this.actions.push(f);
      const from = join(box(), f.Folder!, 'msg0000');
      if (f.Action === 'VoicemailMove') {
        mkdirSync(join(box(), f.ToFolder!), { recursive: true });
        for (const x of ['wav', 'txt'])
          renameSync(`${from}.${x}`, join(box(), f.ToFolder!, `msg0000.${x}`));
      }
      if (f.Action === 'VoicemailRemove') for (const x of ['wav', 'txt']) rmSync(`${from}.${x}`);
      return { Response: 'Success' };
    };
    leave('1792300385-00000000', '"Bob" <13125550000>');
    await t.app.voicemail.scan('101');
  });
  afterAll(() => t?.close());

  it('lists my messages; someone without an extension gets a 404', async () => {
    const r = await dan('GET', '/api/me/voicemail');
    expect(r.statusCode).toBe(200);
    expect(r.json().items).toEqual([
      expect.objectContaining({ folder: 'INBOX', callerName: 'Bob', durationS: 1 }),
    ]);
    expect((await eve('GET', '/api/me/voicemail')).statusCode).toBe(404);
  });

  it('streams the audio with Range support; only to the owner', async () => {
    const [m] = (await dan('GET', '/api/me/voicemail')).json().items;
    const full = await dan('GET', `/api/me/voicemail/${m.id}/audio`);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toMatch(/^audio\/(x-)?wav/);
    expect(full.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    const part = await dan('GET', `/api/me/voicemail/${m.id}/audio`, undefined, {
      range: 'bytes=0-99',
    });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload).toHaveLength(100);
    const dl = await dan('GET', `/api/me/voicemail/${m.id}/audio?download=1`);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="voicemail-/);
    expect((await eve('GET', `/api/me/voicemail/${m.id}/audio`)).statusCode).toBe(404);
  });

  it('mark read moves it to Old through AMI, then delete removes it', async () => {
    const [m] = (await dan('GET', '/api/me/voicemail')).json().items;
    const r = await dan('PATCH', `/api/me/voicemail/${m.id}`, { folder: 'Old' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: m.id, folder: 'Old' });
    expect(t.ami.actions.at(-1)).toEqual({
      Context: 'default',
      Mailbox: '101',
      Action: 'VoicemailMove',
      Folder: 'INBOX',
      ID: '1792300385-00000000',
      ToFolder: 'Old',
    });
    expect((await dan('DELETE', `/api/me/voicemail/${m.id}`)).statusCode).toBe(200);
    expect(t.ami.actions.at(-1)).toMatchObject({ Action: 'VoicemailRemove', Folder: 'Old' });
    expect((await dan('GET', '/api/me/voicemail')).json().items).toEqual([]);
    expect((await dan('DELETE', `/api/me/voicemail/${m.id}`)).statusCode).toBe(404);
  });

  it('a mailbox action while Asterisk is down is a 503', async () => {
    leave('1792300999-00000001', '<102>');
    await t.app.voicemail.scan('101');
    const [m] = (await dan('GET', '/api/me/voicemail')).json().items;
    t.ami.connected = false;
    expect((await dan('DELETE', `/api/me/voicemail/${m.id}`)).statusCode).toBe(503);
    t.ami.connected = true;
  });

  it.skipIf(!hasFfmpeg)('greetings: upload any audio → 8 kHz wav; play; delete', async () => {
    expect((await dan('GET', '/api/me/greetings')).json()).toEqual({
      unavail: false,
      busy: false,
      greet: false,
      temp: false,
    });
    const put = await dan('PUT', '/api/me/greetings/unavail', silenceWav(2), {
      'content-type': 'audio/webm',
    });
    expect(put.statusCode, put.body).toBe(200);
    expect((await dan('GET', '/api/me/greetings')).json().unavail).toBe(true);
    const audio = await dan('GET', '/api/me/greetings/unavail/audio');
    expect(audio.statusCode).toBe(200);
    expect(audio.rawPayload.readUInt32LE(24)).toBe(8000);
    const junk = await dan('PUT', '/api/me/greetings/busy', Buffer.from('not audio'), {
      'content-type': 'audio/ogg',
    });
    expect(junk.statusCode).toBe(400);
    expect((await dan('PUT', '/api/me/greetings/nope', silenceWav())).statusCode).toBe(400);
    expect((await dan('DELETE', '/api/me/greetings/unavail')).statusCode).toBe(200);
    expect((await dan('GET', '/api/me/greetings/unavail/audio')).statusCode).toBe(404);
  });
});
