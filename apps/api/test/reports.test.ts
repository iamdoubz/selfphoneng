// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T6: /api/reports/summary and /api/reports/queues (04 §7.3), days in the company time zone;
// /api/me/reports/summary, the calls made to me.
import type { LightMyRequestResponse } from 'fastify';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callExtensions, calls, extensions, queueCalls, queues } from '../src/db/schema.ts';
import { encrypt } from '../src/crypto/secrets.ts';
import { setSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('/api/reports', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let get: (url: string, cookie?: string) => Promise<LightMyRequestResponse>;
  let admin: string;

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    admin = await t.login(ADMIN.email, ADMIN.password);
    get = (url, cookie = admin) => t.app.inject({ method: 'GET', url, headers: { ...H, cookie } });
    await setSetting(t.db, 'general.timezone', 'America/Chicago'); // UTC-5 in May
    const call = (
      linkedid: string,
      at: string,
      direction: 'inbound' | 'outbound' | 'internal',
      status: 'answered' | 'missed' | 'voicemail' | 'busy',
      talkSeconds = 0,
      lineSeconds = talkSeconds, // arrival to hang-up
    ) => ({
      linkedid,
      direction,
      status,
      startedAt: new Date(at),
      endedAt: new Date(Date.parse(at) + lineSeconds * 1000),
      talkSeconds,
    });
    await t.db.insert(calls).values([
      call('a', '2026-05-04T14:00:00Z', 'inbound', 'answered', 60, 75), // Mon 09:00 local
      call('b', '2026-05-04T14:30:00Z', 'inbound', 'missed', 0, 20), // Mon 09:30
      call('c', '2026-05-04T15:00:00Z', 'outbound', 'answered', 120, 130), // Mon 10:00
      call('d', '2026-05-05T03:00:00Z', 'inbound', 'voicemail', 0, 40), // still Mon, 22:00
      call('e', '2026-05-06T13:00:00Z', 'internal', 'busy', 0, 5), // Wed 08:00
      call('f', '2026-05-09T12:00:00Z', 'inbound', 'answered', 30), // outside the range
    ]);
    const [q] = await t.db
      .insert(queues)
      .values({ number: '550', name: 'Sales', timeoutDestination: { type: 'hangup' } })
      .returning();
    await t.db.insert(queueCalls).values([
      {
        queueId: q!.id,
        uniqueid: '1',
        linkedid: '1',
        joinedAt: new Date('2026-05-04T14:00:00Z'),
        outcome: 'answered',
        waitSeconds: 5,
      },
      {
        queueId: q!.id,
        uniqueid: '2',
        linkedid: '2',
        joinedAt: new Date('2026-05-04T14:05:00Z'),
        outcome: 'abandoned',
        waitSeconds: 40,
      },
      {
        queueId: q!.id,
        uniqueid: '3',
        linkedid: '3',
        joinedAt: new Date('2026-05-09T14:05:00Z'),
        outcome: 'answered',
        waitSeconds: 1,
      },
    ]);
  });
  afterAll(() => t?.close());

  it('summary: per day by direction, missed, average talk, busiest hours', async () => {
    const r = await get('/api/reports/summary?from=2026-05-04&to=2026-05-06');
    expect(r.statusCode, r.body).toBe(200);
    const s = r.json();
    expect(s.days).toEqual([
      // outside: inbound 75 + 20 + 40 s from arrival, outbound 120 s talk = 255 s, 4 minutes
      { date: '2026-05-04', inbound: 3, outbound: 1, internal: 0, missed: 2, outsideMinutes: 4 },
      { date: '2026-05-05', inbound: 0, outbound: 0, internal: 0, missed: 0, outsideMinutes: 0 },
      { date: '2026-05-06', inbound: 0, outbound: 0, internal: 1, missed: 0, outsideMinutes: 0 },
    ]);
    expect(s.totals).toEqual({
      calls: 5,
      answered: 2,
      missed: 2,
      avgTalkSeconds: 90,
      talkSeconds: 180,
      outsideSeconds: { inbound: 135, outbound: 120 },
    });
    expect(s.hours).toHaveLength(7);
    expect(s.hours[1][9]).toBe(2);
    expect(s.hours[1][10]).toBe(1);
    expect(s.hours[1][22]).toBe(1);
    expect(s.hours[3][8]).toBe(1);
    expect(s.hours.flat().reduce((a: number, b: number) => a + b)).toBe(5);
  });

  it('queues: offered, answered, abandoned, wait and service level', async () => {
    const r = await get('/api/reports/queues?from=2026-05-04&to=2026-05-06');
    expect(r.json().items).toEqual([
      expect.objectContaining({
        number: '550',
        name: 'Sales',
        offered: 2,
        answered: 1,
        abandoned: 1,
        avgWaitSeconds: 5,
        withinSlaPercent: 50,
      }),
    ]);
  });

  it('defaults to the last 30 days; bad ranges and non-admins are refused', async () => {
    const s = (await get('/api/reports/summary')).json();
    expect(s.days).toHaveLength(30);
    expect(s.days.at(-1).date).toBe(s.to);
    expect((await get('/api/reports/summary?from=2026-05-06&to=2026-05-04')).statusCode).toBe(400);
    expect((await get('/api/reports/summary?from=2025-01-01&to=2026-05-04')).statusCode).toBe(400);
    expect((await get('/api/reports/summary?from=nope')).statusCode).toBe(400);
    await t.addUser('pat@example.com', 'pat-password-123');
    const pat = await t.login('pat@example.com', 'pat-password-123');
    expect((await get('/api/reports/queues', pat)).statusCode).toBe(403);
    expect((await get('/api/me/reports/summary', pat)).statusCode).toBe(404); // no extension
  });

  it('mine: only calls made to me; answered and talk time are the ones I picked up', async () => {
    const sam = await t.addUser('sam@example.com', 'sam-password-123');
    const [mine, other] = await t.db
      .insert(extensions)
      .values(
        (['103', '104'] as const).map((number) => ({
          number,
          name: number,
          sipPasswordEnc: encrypt('x'),
          voicemailPinEnc: encrypt('4826'),
          userId: number === '103' ? sam.id : null,
        })),
      )
      .returning();
    await t.db.insert(calls).values({
      linkedid: 'g',
      direction: 'internal',
      status: 'answered',
      startedAt: new Date('2026-05-05T15:00:00Z'), // Tue 10:00
      endedAt: new Date('2026-05-05T15:00:45Z'),
      talkSeconds: 40,
      answeredByExtensionId: mine!.id,
    });
    const ids = Object.fromEntries(
      (
        await t.db
          .select({ id: calls.id, linkedid: calls.linkedid })
          .from(calls)
          .where(inArray(calls.linkedid, ['a', 'b', 'c', 'g']))
      ).map((c) => [c.linkedid, c.id]),
    );
    // a: rang me and a coworker, the coworker answered. b: rang me, missed. c: I made it. g: mine.
    await t.db
      .update(calls)
      .set({ answeredByExtensionId: other!.id })
      .where(inArray(calls.id, [ids.a!]));
    await t.db.insert(callExtensions).values([
      { callId: ids.a!, extensionId: mine!.id, role: 'rang' },
      { callId: ids.a!, extensionId: other!.id, role: 'answered' },
      { callId: ids.b!, extensionId: mine!.id, role: 'rang' },
      { callId: ids.c!, extensionId: mine!.id, role: 'caller' },
      { callId: ids.g!, extensionId: mine!.id, role: 'rang' },
      { callId: ids.g!, extensionId: mine!.id, role: 'answered' },
    ]);
    const cookie = await t.login('sam@example.com', 'sam-password-123');
    const r = await get('/api/me/reports/summary?from=2026-05-04&to=2026-05-06', cookie);
    expect(r.statusCode, r.body).toBe(200);
    const s = r.json();
    expect(s.days).toEqual([
      { date: '2026-05-04', inbound: 2, outbound: 0, internal: 0, missed: 1, outsideMinutes: 2 },
      { date: '2026-05-05', inbound: 0, outbound: 0, internal: 1, missed: 0, outsideMinutes: 0 },
      { date: '2026-05-06', inbound: 0, outbound: 0, internal: 0, missed: 0, outsideMinutes: 0 },
    ]);
    expect(s.totals).toEqual({
      calls: 3,
      answered: 1,
      missed: 1,
      avgTalkSeconds: 40,
      talkSeconds: 40,
      outsideSeconds: { inbound: 95, outbound: 0 },
    });
    expect(s.hours.flat().reduce((a: number, b: number) => a + b)).toBe(3);
    // The company summary is unchanged by who rang.
    expect(
      (await get('/api/reports/summary?from=2026-05-04&to=2026-05-04')).json().totals.answered,
    ).toBe(2);
  });
});
