// SPDX-License-Identifier: AGPL-3.0-or-later
// The call report email (05 §4): its periods, and who gets what.
import type { LightMyRequestResponse } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callExtensions, calls, extensions, recordings } from '../src/db/schema.ts';
import { lastPeriod, sendCallReports } from '../src/services/callreport.ts';
import { setSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('call report email', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let dan: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let extId: string;
  const tz = 'America/Chicago';
  const period = (callReport: 'hourly' | 'daily' | 'weekly', now: string, at = '08:00', wd = 1) =>
    lastPeriod(
      t.db,
      tz,
      { callReport, callReportTime: at, callReportWeekday: wd },
      new Date(now),
    ).then((p) => [p.from.toISOString(), p.to.toISOString()]);
  const run = (now: string) =>
    sendCallReports({ db: t.db, send: t.app.sendMail, log: t.app.log, now: new Date(now) });

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    await setSetting(t.db, 'general.timezone', tz);
    const as = (cookie: string) => (method: string, url: string, payload?: unknown) =>
      t.app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { ...H, cookie },
      });
    const admin = as(await t.login(ADMIN.email, ADMIN.password));
    const danId = (await t.addUser('dan@example.com', 'dan-password-123')).id;
    extId = (
      await admin('POST', '/api/extensions', { number: '101', name: 'Dan Doe', userId: danId })
    ).json().id;
    dan = as(await t.login('dan@example.com', 'dan-password-123'));
  });
  afterAll(() => t?.close());

  it('periods end at the last scheduled local time, DST included', async () => {
    // CDT is UTC-5. 2026-10-23 is a Friday.
    expect(await period('hourly', '2026-10-23T14:25:00Z')).toEqual([
      '2026-10-23T13:00:00.000Z',
      '2026-10-23T14:00:00.000Z',
    ]);
    expect(await period('daily', '2026-10-23T14:25:00Z')).toEqual([
      '2026-10-22T13:00:00.000Z',
      '2026-10-23T13:00:00.000Z',
    ]);
    // 07:59 local: still yesterday's period.
    expect(await period('daily', '2026-10-23T12:59:00Z')).toEqual([
      '2026-10-21T13:00:00.000Z',
      '2026-10-22T13:00:00.000Z',
    ]);
    // Weekly on Monday 08:00, asked on Friday: the week up to this Monday.
    expect(await period('weekly', '2026-10-23T14:25:00Z')).toEqual([
      '2026-10-12T13:00:00.000Z',
      '2026-10-19T13:00:00.000Z',
    ]);
    // DST ends 02:00 Sunday 2026-11-01 (CDT to CST, UTC-6): Saturday 08:00 to Sunday 08:00 is 25 h.
    expect(await period('daily', '2026-11-01T15:00:00Z')).toEqual([
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
    ]);
  });

  it('PATCH /api/me saves the schedule, starting with the next period', async () => {
    const r = await dan('PATCH', '/api/me', {
      callReport: 'daily',
      callReportTime: '17:30',
      callReportSummaries: true,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      callReport: 'daily',
      callReportTime: '17:30',
      callReportWeekday: 1,
      callReportSummaries: true,
    });
    const [e] = await t.db.select().from(extensions).where(eq(extensions.id, extId));
    expect(e!.callReportSentAt).not.toBeNull();
    expect((await dan('PATCH', '/api/me', { callReportTime: '25:00' })).statusCode).toBe(400);
  });

  it('emails the calls of the period once, and nothing for a period without calls', async () => {
    await dan('PATCH', '/api/me', { callReport: 'daily', callReportTime: '08:00' });
    await t.db.update(extensions).set({ callReportSentAt: null }).where(eq(extensions.id, extId));
    await setSetting(t.db, 'ai.callTranscripts', true);
    await setSetting(t.db, 'ai.callSummaries', true);
    const [rec] = await t.db
      .insert(recordings)
      .values({
        linkedid: 'r1',
        filePath: '2026/10/22/r1.wav',
        startedAt: new Date('2026-10-22T15:00:00Z'),
        summary: 'Acme wants a quote.\nAction items:\n- Dan sends the quote',
        aiDoneAt: new Date(),
      })
      .returning();
    const [inCall, outCall, before] = await t.db
      .insert(calls)
      .values([
        {
          linkedid: 'c1',
          direction: 'inbound',
          status: 'answered',
          startedAt: new Date('2026-10-22T15:00:00Z'),
          endedAt: new Date('2026-10-22T15:03:12Z'),
          fromNumber: '13125551234',
          fromName: 'Acme',
          toNumber: '13125550000',
          talkSeconds: 192,
          answeredByExtensionId: extId,
          recordingId: rec!.id,
        },
        {
          linkedid: 'c2',
          direction: 'outbound',
          status: 'answered',
          startedAt: new Date('2026-10-22T20:00:00Z'),
          endedAt: new Date('2026-10-22T20:00:45Z'),
          fromNumber: '101',
          toNumber: '18005550100',
          talkSeconds: 40,
        },
        {
          linkedid: 'c3', // the period before
          direction: 'inbound',
          status: 'missed',
          startedAt: new Date('2026-10-21T15:00:00Z'),
          endedAt: new Date('2026-10-21T15:00:20Z'),
          fromNumber: '13125559999',
        },
      ])
      .returning();
    await t.db.insert(callExtensions).values([
      { callId: inCall!.id, extensionId: extId, role: 'answered' },
      { callId: outCall!.id, extensionId: extId, role: 'caller' },
      { callId: before!.id, extensionId: extId, role: 'rang' },
    ]);

    t.mails.length = 0;
    // Today 08:00 CDT is 13:00Z; the report waits a few minutes for the last calls and summaries.
    expect(await run('2026-10-23T13:02:00Z')).toBe(1); // yesterday's period, never reported
    t.mails.length = 0;
    await t.db
      .update(extensions)
      .set({ callReportSentAt: new Date('2026-10-22T13:00:00Z') })
      .where(eq(extensions.id, extId));
    expect(await run('2026-10-23T13:06:00Z')).toBe(1);
    expect(await run('2026-10-23T13:07:00Z')).toBe(0); // once
    expect(t.mails).toHaveLength(1);
    const m = t.mails[0]!;
    expect(m.to).toEqual(['dan@example.com']);
    expect(m.subject).toBe('Your calls (101): 2 calls');
    expect(m.text).toContain('Incoming from (312) 555-1234 (Acme) to (312) 555-0000');
    expect(m.text).toContain('answered · 3:12 · recorded');
    expect(m.text).toContain('  - Dan sends the quote');
    expect(m.text).toContain('Outgoing to (800) 555-0100');
    expect(m.text).toContain('answered · 0:40\n');
    expect(m.text).not.toContain('555-9999');
    expect(m.text.indexOf('Incoming')).toBeLessThan(m.text.indexOf('Outgoing'));

    // The next day had no calls: no email.
    expect(await run('2026-10-24T13:06:00Z')).toBe(0);
    expect(t.mails).toHaveLength(1);

    // Summaries off: the calls, not what was said.
    await dan('PATCH', '/api/me', { callReportSummaries: false });
    await t.db
      .update(extensions)
      .set({ callReportSentAt: new Date('2026-10-22T13:00:00Z') })
      .where(eq(extensions.id, extId));
    await run('2026-10-23T13:06:00Z');
    expect(t.mails[1]!.text).not.toContain('quote');
  });

  it('no recording or summary of a call that only rang my phone (08 §7 #3)', async () => {
    await dan('PATCH', '/api/me', { callReportSummaries: true });
    const [rec] = await t.db
      .insert(recordings)
      .values({
        linkedid: 'r4',
        filePath: '2026/10/24/r4.wav',
        startedAt: new Date('2026-10-24T15:00:00Z'),
        summary: 'Secret pricing for Acme',
        aiDoneAt: new Date(),
      })
      .returning();
    const [c] = await t.db
      .insert(calls)
      .values({
        linkedid: 'c4', // the ring group rang Dan; a coworker answered and talked
        direction: 'inbound',
        status: 'answered',
        startedAt: new Date('2026-10-24T15:00:00Z'),
        endedAt: new Date('2026-10-24T15:05:00Z'),
        fromNumber: '13125557777',
        talkSeconds: 300,
        recordingId: rec!.id,
      })
      .returning();
    await t.db.insert(callExtensions).values({ callId: c!.id, extensionId: extId, role: 'rang' });
    await t.db
      .update(extensions)
      .set({ callReportSentAt: new Date('2026-10-24T13:00:00Z') })
      .where(eq(extensions.id, extId));
    t.mails.length = 0;
    expect(await run('2026-10-25T13:06:00Z')).toBe(1);
    const text = t.mails[0]!.text;
    expect(text).toContain('Incoming from (312) 555-7777');
    expect(text).not.toContain('Secret pricing');
    expect(text).not.toContain('recorded');
    expect(text).not.toContain('Summary not ready');
  });
});
