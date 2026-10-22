// SPDX-License-Identifier: AGPL-3.0-or-later
// Spec 10 §3: call transcripts and summaries. The job writes out each side of a recorded call,
// merges them by time, asks the language model for a summary and removes the side files; the
// Recordings page can search them, and only the people on the call (and admins) can read them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AmiMessage } from '../src/ami/events.ts';
import { transcribeCalls } from '../src/ai/calls.ts';
import { encrypt } from '../src/crypto/secrets.ts';
import { cdr, extensions, recordings } from '../src/db/schema.ts';
import { aggregateCall, toCdrRow } from '../src/services/cdr.ts';
import { setSetting } from '../src/services/settings.ts';
import { silenceWav, toneWav } from './audio.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const FILE = '2026/10/21/1792351748.9.wav';

describe.skipIf(!hasTestDb)('call transcripts and summaries', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let ai: Server;
  let down = false;
  const asked: string[] = [];
  let as: Record<'admin' | 'alice' | 'bob', (url: string) => Promise<LightMyRequestResponse>>;
  let recId: string;
  const dir = () => t.app.config.RECORDINGS_DIR;
  const log = { error: () => {} };
  const sides = () => [`${FILE.slice(0, -4)}-in.wav`, `${FILE.slice(0, -4)}-out.wav`];
  /** The side files: someone speaking (a tone) on each; the other side speaks longer. */
  const writeSides = () => {
    writeFileSync(join(dir(), sides()[0]!), toneWav(1));
    writeFileSync(join(dir(), sides()[1]!), toneWav(2));
  };
  const pending = () =>
    t.db
      .update(recordings)
      .set({ aiDoneAt: null, aiError: null, transcript: null, summary: null })
      .where(eq(recordings.id, recId));

  beforeAll(async () => {
    ai = createServer((req, res) => {
      let body = '';
      req.setEncoding('latin1').on('data', (c: string) => (body += c));
      req.on('end', () => {
        if (down) return res.destroy();
        asked.push(req.url!);
        if (req.url === '/v1/audio/transcriptions')
          return res.end(
            JSON.stringify(
              body.length < 30_000 // the caller's stretch: about a second
                ? {
                    text: '…',
                    segments: [
                      { start: 0.4, text: ' Hi, I never got the invoice.' },
                      { start: 6.2, text: ' Great, thanks.' },
                    ],
                  }
                : { text: '…', segments: [{ start: 2.9, text: " I'll email it today." }] },
            ),
          );
        if (req.url === '/v1/chat/completions') {
          expect(body).toContain('Caller: Hi, I never got the invoice.\\nOther side: I');
          return res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '<think>short call</think>The caller never got their invoice; it will be emailed today.\nAction items:\n- Email the invoice today',
                  },
                },
              ],
            }),
          );
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => ai.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(ai.address() as AddressInfo).port}/v1`;

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
    const events: AmiMessage[] = JSON.parse(
      readFileSync(new URL('./fixtures/cdr/inbound-user.json', import.meta.url), 'utf8'),
    );
    for (const e of events) await t.db.insert(cdr).values(toCdrRow({ ...e, sp_recording: FILE }));
    mkdirSync(join(dir(), '2026/10/21'), { recursive: true });
    writeFileSync(join(dir(), FILE), silenceWav(2));
    await aggregateCall(t.db, String(events[0]!.LinkedID), { recordingsDir: dir() });
    const [r] = await t.db.select().from(recordings);
    recId = r!.id;
    // A call that ended a minute ago (the fixture's date is older than the job looks).
    await t.db
      .update(recordings)
      .set({
        startedAt: sql`now() - interval '5 minutes'`,
        createdAt: sql`now() - interval '1 minute'`,
      })
      .where(eq(recordings.id, recId));
    await setSetting(t.db, 'ai.stt', { url, model: 'whisper' });
    await setSetting(t.db, 'ai.llm', { url, model: 'qwen3:4b' });
    await setSetting(t.db, 'ai.callTranscripts', true);
    await setSetting(t.db, 'ai.callSummaries', true);
    const mk = (cookie: string) => (url: string) =>
      t.app.inject({ method: 'GET', url, headers: { ...H, cookie } });
    as = {
      admin: mk(await t.login(ADMIN.email, ADMIN.password)),
      alice: mk(await t.login('alice@example.com', 'alice-password-123')),
      bob: mk(await t.login('bob@example.com', 'bob-password-123')),
    };
  });
  afterAll(async () => {
    await t?.close();
    ai?.close();
  });

  it('without side files (recorded before it was on): marked, nothing asked', async () => {
    expect(await transcribeCalls({ db: t.db, dir: dir(), log })).toBe(0);
    const [r] = await t.db.select().from(recordings).where(eq(recordings.id, recId));
    expect(r).toMatchObject({
      aiError: 'Recorded before call transcripts were on',
      transcript: null,
    });
    expect(r!.aiDoneAt).not.toBeNull();
    expect(asked).toEqual([]);
  });

  it('the AI stack down: the call waits for the next run', async () => {
    await pending();
    writeSides();
    down = true;
    expect(await transcribeCalls({ db: t.db, dir: dir(), log })).toBe(0);
    down = false;
    const [r] = await t.db.select().from(recordings).where(eq(recordings.id, recId));
    expect(r!.aiDoneAt).toBeNull();
    expect(existsSync(join(dir(), sides()[0]!))).toBe(true);
  });

  it('both sides written out and merged by time, summarized, side files removed', async () => {
    expect(await transcribeCalls({ db: t.db, dir: dir(), log })).toBe(1);
    const [r] = await t.db.select().from(recordings).where(eq(recordings.id, recId));
    expect(r!.transcript).toEqual([
      { side: 'caller', at: 0.4, text: 'Hi, I never got the invoice.' },
      { side: 'other', at: 2.9, text: "I'll email it today." },
      { side: 'caller', at: 6.2, text: 'Great, thanks.' },
    ]);
    expect(r!.summary).toBe(
      'The caller never got their invoice; it will be emailed today.\nAction items:\n- Email the invoice today',
    );
    expect(r!.aiError).toBeNull();
    for (const f of sides()) expect(existsSync(join(dir(), f))).toBe(false);
    expect(existsSync(join(dir(), FILE))).toBe(true); // the recording itself stays
    // done once: a second run asks nothing
    const n = asked.length;
    await transcribeCalls({ db: t.db, dir: dir(), log });
    expect(asked).toHaveLength(n);
  });

  it('the list shows the summary and finds the call by what was said', async () => {
    const list = (await as.admin('/api/recordings')).json();
    expect(list.items[0]).toMatchObject({
      id: recId,
      hasTranscript: true,
      summary: expect.stringContaining('invoice'),
    });
    expect((await as.admin('/api/recordings?q=email%20it')).json().items).toHaveLength(1);
    expect((await as.admin('/api/recordings?q=refund')).json().items).toHaveLength(0);
    expect((await as.admin('/api/recordings?q=100%25')).json().items).toHaveLength(0); // % literal
  });

  it('the transcript: admins and the people on the call only', async () => {
    const r = await as.alice(`/api/recordings/${recId}/transcript`);
    expect(r.statusCode).toBe(200);
    expect(r.json().lines).toHaveLength(3);
    expect((await as.bob(`/api/recordings/${recId}/transcript`)).statusCode).toBe(403);
    expect((await as.admin(`/api/recordings/${recId}/transcript`)).statusCode).toBe(200);
  });

  it('the dialplan records each side only while call transcripts are on', async () => {
    await t.app.generator.apply({ trigger: 'test', force: true });
    const globals = () =>
      readFileSync(join(t.genDir, 'extensions_globals_selfphoneng.conf'), 'utf8');
    expect(globals()).toContain('SP_REC_SIDES=1\n');
    await setSetting(t.db, 'ai.callTranscripts', false);
    await t.app.generator.apply({ trigger: 'test', force: true });
    expect(globals()).toContain('SP_REC_SIDES=\n');
  });
});
