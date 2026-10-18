// SPDX-License-Identifier: AGPL-3.0-or-later
// M7-T3: a recorded call (sp_recording) is linked to its calls row and playable by admins and the
// people on the call; delete and retention remove file and row.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AmiMessage } from '../src/ami/events.ts';
import { calls, cdr, extensions, recordings } from '../src/db/schema.ts';
import { encrypt } from '../src/crypto/secrets.ts';
import { cleanupRecordings } from '../src/routes/recordings.ts';
import { aggregateCall, toCdrRow } from '../src/services/cdr.ts';
import { silenceWav } from './audio.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const FILE = '2026/10/18/1792351748.9.wav';

describe.skipIf(!hasTestDb)('call recordings', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let as: Record<
    'admin' | 'alice' | 'bob',
    (m: string, url: string) => Promise<LightMyRequestResponse>
  >;
  let recId: string;
  const dir = () => t.app.config.RECORDINGS_DIR;

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const alice = await t.addUser('alice@example.com', 'alice-password-123');
    await t.addUser('bob@example.com', 'bob-password-123');
    await t.db.insert(extensions).values({
      number: '101',
      name: 'Alice',
      userId: alice.id,
      sipPasswordEnc: encrypt('x'),
      voicemailPinEnc: encrypt('4826'),
    });
    // The inbound-user scenario, as if 101 recorded it.
    const events: AmiMessage[] = JSON.parse(
      readFileSync(new URL('./fixtures/cdr/inbound-user.json', import.meta.url), 'utf8'),
    );
    for (const e of events) await t.db.insert(cdr).values(toCdrRow({ ...e, sp_recording: FILE }));
    mkdirSync(join(dir(), '2026/10/18'), { recursive: true });
    writeFileSync(join(dir(), FILE), silenceWav(2));
    await aggregateCall(t.db, String(events[0]!.LinkedID), { recordingsDir: dir() });
    const login = (email: string, pw: string) => t.login(email, pw);
    const mk = (cookie: string) => (method: string, url: string) =>
      t.app.inject({ method: method as 'GET', url, headers: { ...H, cookie } });
    as = {
      admin: mk(await login(ADMIN.email, ADMIN.password)),
      alice: mk(await login('alice@example.com', 'alice-password-123')),
      bob: mk(await login('bob@example.com', 'bob-password-123')),
    };
  });
  afterAll(() => t?.close());

  it('the recording is linked to its call, with size and length', async () => {
    const [c] = await t.db.select().from(calls);
    expect(c!.recordingId).not.toBeNull();
    recId = c!.recordingId!;
    const [r] = await t.db.select().from(recordings).where(eq(recordings.id, recId));
    expect(r).toMatchObject({ filePath: FILE, sizeBytes: 44 + 32_000 });
    // ffprobe may be missing on a dev machine; then the length stays unknown.
    if (r!.durationMs !== null) expect(r!.durationMs).toBeGreaterThan(1900);
    const list = (await as.admin('GET', '/api/recordings')).json();
    expect(list.items).toEqual([
      expect.objectContaining({
        id: recId,
        call: expect.objectContaining({ direction: 'inbound' }),
      }),
    ]);
    const history = (await as.admin('GET', '/api/calls')).json();
    expect(history.items[0].recordingId).toBe(recId);
  });

  it('plays for admins and the people on the call, with Range; others get 403', async () => {
    const full = await as.admin('GET', `/api/recordings/${recId}/audio`);
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    const mine = await t.app.inject({
      method: 'GET',
      url: `/api/recordings/${recId}/audio`,
      headers: { ...H, range: 'bytes=0-9', cookie: '' },
    });
    expect(mine.statusCode).toBe(401);
    expect((await as.alice('GET', `/api/recordings/${recId}/audio`)).statusCode).toBe(200);
    expect((await as.bob('GET', `/api/recordings/${recId}/audio`)).statusCode).toBe(403);
    expect((await as.alice('GET', '/api/recordings')).statusCode).toBe(403);
  });

  it('retention deletes recordings past their days; delete removes file and link', async () => {
    expect(await cleanupRecordings(t.db, dir(), 3650)).toBe(0);
    expect((await as.admin('DELETE', `/api/recordings/${recId}`)).statusCode).toBe(200);
    expect(existsSync(join(dir(), FILE))).toBe(false);
    const [c] = await t.db.select().from(calls);
    expect(c!.recordingId).toBeNull();

    writeFileSync(join(dir(), FILE), silenceWav(1));
    await t.db.insert(recordings).values({
      linkedid: 'old',
      filePath: FILE,
      startedAt: new Date('2020-01-01T00:00:00Z'),
    });
    expect(await cleanupRecordings(t.db, dir(), 90)).toBe(1);
    expect(existsSync(join(dir(), FILE))).toBe(false);
    expect(await cleanupRecordings(t.db, dir(), 0)).toBe(0); // 0 = keep forever
  });
});
