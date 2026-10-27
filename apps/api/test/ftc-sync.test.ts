// SPDX-License-Identifier: AGPL-3.0-or-later
// SD3: the FTC complaint download (14 §2.2) against a fake api.ftc.gov with three days of data.
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPAM_DEFAULTS } from '@selfphoneng/shared';
import { encrypt, setSecretKey } from '../src/crypto/secrets.ts';
import type { Db } from '../src/db/client.ts';
import { ftcComplaints, settings } from '../src/db/schema.ts';
import { ftcSync } from '../src/spam/ftc.ts';
import { getSetting, setSetting } from '../src/services/settings.ts';
import { createTestDb, hasTestDb } from './db.ts';

const KEY = 'datagov-secret-key-456';
const NOW = new Date('2026-10-27T18:00:00Z'); // 14:00 in Washington
const hour = 3_600_000;

const at = (day: string, i: number) =>
  `${day} ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`;
const ftc = (id: string, phone: string, created: string, robo = 'Y') => ({
  type: 'dnc_complaint',
  id,
  attributes: {
    'company-phone-number': phone,
    'created-date': created,
    subject: 'Warranties',
    'recorded-message-or-robocall': robo,
  },
});
/** 120 complaints on the 25th (three pages), 3 on the 26th, 3 today (one usable). */
const DATA = [
  ...Array.from({ length: 120 }, (_, i) => ftc(`a${i}`, '3125550100', at('2026-10-25', i))),
  ...[0, 1, 2].map((i) => ftc(`b${i}`, '3125550101', at('2026-10-26', i), 'N')),
  ftc('c0', '3125550102', '2026-10-27 09:00:00', ''),
  ftc('c1', '', '2026-10-27 09:01:00'), // no number
  ftc('c2', '3125550102', '2026-10-27'), // no time
];

describe.skipIf(!hasTestDb)('FTC complaint download', () => {
  let db: Db;
  let drop: () => Promise<void>;
  /** Each request's day and offset. */
  const asked: string[] = [];
  let fail: { at: number; status: number } | null = null;

  const turnOn = (keyEnc = encrypt(KEY)) =>
    setSetting(db, 'spam', {
      ...SPAM_DEFAULTS,
      enabled: true,
      ftc: { keyEnc, syncHours: 24, windowDays: 7 },
    });
  const stored = async () => (await db.select().from(ftcComplaints)).length;
  const reset = async () => {
    await db.delete(ftcComplaints);
    await db.delete(settings).where(eq(settings.key, 'spam.state'));
  };

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    setSecretKey(randomBytes(32).toString('base64'));
  });
  afterAll(() => drop?.());

  beforeEach(() => {
    asked.length = 0;
    fail = null;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
      if ((init?.headers as Record<string, string>)['X-Api-Key'] !== KEY) return json({}, 403);
      const q = new URL(url).searchParams;
      const day = /^"(\d{4}-\d{2}-\d{2}) 00:00:00"$/.exec(q.get('created_date_from')!)![1]!;
      expect(q.get('created_date_to')).toBe(`"${day} 23:59:59"`);
      expect(q.get('sort_order')).toBe('ASC');
      const offset = Number(q.get('offset'));
      asked.push(`${day}+${offset}`);
      if (fail && asked.length === fail.at) return json({}, fail.status);
      const all = DATA.filter((c) => c.attributes['created-date'].startsWith(day));
      return json({ data: all.slice(offset, offset + 50), meta: { 'record-total': all.length } });
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await reset();
  });

  it('downloads nothing while spam check or the FTC list is off', async () => {
    await setSetting(db, 'spam', SPAM_DEFAULTS);
    expect(await ftcSync(db, { now: NOW })).toBeNull();
    await setSetting(db, 'spam', { ...SPAM_DEFAULTS, enabled: true });
    expect(await ftcSync(db, { now: NOW })).toBeNull();
    expect(asked).toEqual([]);
  });

  it('the first download fills the window a day at a time and drops old complaints', async () => {
    await turnOn();
    await db.insert(ftcComplaints).values({
      id: 'old',
      number: '13125550109',
      reportedAt: sql`${NOW.toISOString()}::timestamptz - interval '8 days'`,
    });
    expect(await ftcSync(db, { now: NOW, budget: 100 })).toBeNull();
    expect(asked).toEqual([
      '2026-10-20+0',
      '2026-10-21+0',
      '2026-10-22+0',
      '2026-10-23+0',
      '2026-10-24+0',
      '2026-10-25+0',
      '2026-10-25+50',
      '2026-10-25+100',
      '2026-10-26+0',
      '2026-10-27+0',
    ]);
    expect(await stored()).toBe(124);
    const row = async (id: string) =>
      (await db.select().from(ftcComplaints).where(eq(ftcComplaints.id, id)))[0];
    expect(await row('b0')).toMatchObject({
      number: '13125550101',
      subject: 'Warranties',
      robocall: false,
      reportedAt: new Date('2026-10-26T04:00:00Z'), // midnight in Washington
    });
    expect((await row('c0'))?.robocall).toBeNull();
    expect(await getSetting(db, 'spam.state')).toMatchObject({
      ftcCursor: null,
      ftcLastSyncAt: NOW.toISOString(),
      ftcLastError: null,
    });
  });

  it('not again until syncHours; then from the newest day kept, less one', async () => {
    await turnOn();
    await ftcSync(db, { now: NOW, budget: 100 });
    asked.length = 0;
    await ftcSync(db, { now: new Date(NOW.getTime() + 23 * hour) });
    expect(asked).toEqual([]);
    await ftcSync(db, { now: new Date(NOW.getTime() + 24 * hour) });
    expect(asked).toEqual(['2026-10-26+0', '2026-10-27+0', '2026-10-28+0']);
  });

  it('15 pages a minute, the place saved; a 429 stops there and the next minute carries on', async () => {
    await turnOn();
    await ftcSync(db, { now: NOW });
    expect(asked).toHaveLength(10);
    await reset();
    asked.length = 0;

    await ftcSync(db, { now: NOW, budget: 2 });
    expect((await getSetting(db, 'spam.state')).ftcCursor).toEqual({
      day: '2026-10-22',
      offset: 0,
    });
    fail = { at: 7, status: 429 }; // the 25th's second page
    const said = 'api.data.gov says the key is over its hourly limit';
    expect(await ftcSync(db, { now: NOW })).toBe(said);
    expect(await getSetting(db, 'spam.state')).toMatchObject({
      ftcCursor: { day: '2026-10-25', offset: 50 },
      ftcLastError: said,
      ftcLastSyncAt: null,
    });
    fail = { at: 8, status: 429 }; // the same failure isn't returned (logged) twice
    expect(await ftcSync(db, { now: NOW })).toBeNull();
    fail = null;
    expect(await ftcSync(db, { now: NOW })).toBeNull();
    expect(await stored()).toBe(124);
    expect(await getSetting(db, 'spam.state')).toMatchObject({
      ftcCursor: null,
      ftcLastError: null,
    });
  });

  it('a refused key is saved for the Settings tab', async () => {
    await turnOn(encrypt('wrong'));
    expect(await ftcSync(db, { now: NOW })).toBe('api.data.gov refused the key');
    expect((await getSetting(db, 'spam.state')).ftcLastError).toBe('api.data.gov refused the key');
  });
});
