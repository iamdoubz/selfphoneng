// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T10: fraud alerts (08 §8.3): risky calls, voip.ms calls the PBX didn't make, balance drop.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calls, cdr, dids } from '../src/db/schema.ts';
import { createFraudWatch, riskyDestination, trunkDialNumber } from '../src/services/fraud.ts';
import { setSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe('riskyDestination', () => {
  it('flags international, premium and NANP numbers billed like abroad', () => {
    expect(riskyDestination('01144207946095')).toBe('international');
    expect(riskyDestination('19005551234')).toBe('premium');
    expect(riskyDestination('13129765555')).toBe('premium'); // exchange 976
    expect(riskyDestination('18765551234')).toMatch(/international rates/); // Jamaica
    expect(riskyDestination('8095551234')).toMatch(/international rates/); // 10 digits
    expect(riskyDestination('13125551234')).toBeNull();
    expect(riskyDestination('18005551234')).toBeNull();
    expect(riskyDestination('101')).toBeNull();
  });

  it('reads the number out of a trunk Dial', () => {
    expect(trunkDialNumber('PJSIP/13125550000@trunk-7d3e9a52,120')).toBe('13125550000');
    expect(trunkDialNumber('PJSIP/911@trunk-7d3e9a52')).toBe('911');
    expect(trunkDialNumber('PJSIP/101,30')).toBeNull();
    expect(trunkDialNumber(null)).toBeNull();
  });
});

describe.skipIf(!hasTestDb)('fraud watches', () => {
  const at = (iso: string) => new Date(iso);
  let clock = Date.parse('2026-10-29T12:00:00Z');
  let balance = '100.00';
  const cdrs: Record<string, unknown>[] = [];
  const seen: URLSearchParams[] = [];
  const fake = createServer((req, res) => {
    const q = new URL(req.url!, 'http://x').searchParams;
    seen.push(q);
    res.setHeader('content-type', 'application/json');
    const m = q.get('method');
    res.end(
      JSON.stringify(
        m === 'getBalance'
          ? { status: 'success', balance: { current_balance: balance } }
          : m === 'getCDR'
            ? cdrs.length
              ? { status: 'success', cdr: cdrs }
              : { status: 'no_cdr' }
            : { status: 'invalid_method' },
      ),
    );
  });
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (m: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let trunkId: string;
  let url: string;
  const mails: { subject: string; text: string }[] = [];
  const watch = () =>
    createFraudWatch({
      db: t.db,
      voipmsUrl: url,
      mail: async (subject, text) => void mails.push({ subject, text }),
      log: { warn() {} },
      now: () => new Date(clock),
    });

  beforeAll(async () => {
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/api/v1/rest.php`;
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    req = (method, u, payload) =>
      t.app.inject({
        method: method as 'GET',
        url: u,
        payload: payload as object,
        headers: { ...H, cookie },
      });
    const r = await req('POST', '/api/trunks', {
      name: 'voip.ms',
      serverHost: '127.0.0.1',
      username: '123456_pbx',
      password: 'Sub-account pw!',
    });
    trunkId = r.json().id;
    await req('PATCH', `/api/trunks/${trunkId}`, {
      voipmsApiUsername: 'me@example.com',
      voipmsApiPassword: 'api-pw',
    });
    await t.db.insert(dids).values({
      number: '13125551000',
      trunkId,
      destination: { type: 'hangup' },
    } as typeof dids.$inferInsert);
  });
  afterAll(async () => {
    fake.close();
    await t.close();
  });

  it('riskyCallWatch emails each risky outside call once, and not when turned off', async () => {
    const w = watch();
    mails.length = 0;
    const call = (linkedid: string, to: string, created: string) => ({
      linkedid,
      direction: 'outbound' as const,
      status: 'answered' as const,
      startedAt: at(created),
      endedAt: at(created),
      fromNumber: '101',
      toNumber: to,
      talkSeconds: 125,
      createdAt: at(created),
    });
    await t.db
      .insert(calls)
      .values([
        call('r1', '01144207946095', '2026-10-29T12:00:20Z'),
        call('r2', '18765551234', '2026-10-29T12:00:30Z'),
        call('r3', '13125551234', '2026-10-29T12:00:40Z'),
      ]);
    clock = Date.parse('2026-10-29T12:01:00Z');
    await w.riskyCallWatch();
    expect(mails.map((m) => m.subject)).toEqual(['Calls to risky numbers (2)']);
    expect(mails[0]!.text).toMatch(/from 101 to 01144207946095: international, answered/);
    expect(mails[0]!.text).toMatch(/\(876\) 555-1234: international rates/);
    expect(mails[0]!.text).not.toMatch(/\(312\) 555-1234/);
    clock += 60_000;
    await w.riskyCallWatch(); // nothing new
    expect(mails).toHaveLength(1);

    await setSetting(t.db, 'alerts.riskyCalls', false);
    await t.db.insert(calls).values(call('r4', '19005551234', '2026-10-29T12:01:30Z'));
    clock += 60_000;
    await w.riskyCallWatch();
    expect(mails).toHaveLength(1);
    await setSetting(t.db, 'alerts.riskyCalls', true);
  });

  it('providerWatch reports voip.ms calls the PBX never sent to the trunk, once', async () => {
    await setSetting(t.db, 'alerts.balanceDropPerHour', 0);
    const w = watch();
    mails.length = 0;
    clock = Date.parse('2026-10-29T14:00:00Z');
    // The PBX sent one call to the trunk at 13:00 (a forward would look the same).
    await t.db.insert(cdr).values({
      uniqueid: 'u1',
      linkedid: 'u1',
      startAt: at('2026-10-29T13:00:05Z'),
      lastdata: `PJSIP/13125550000@trunk-${trunkId},120`,
      raw: {},
    });
    const rec = (uniqueid: string, date: string, destination: string) => ({
      date,
      callerid: '"Office" <3125551000>',
      destination,
      description: 'Outgoing',
      account: '123456_pbx',
      disposition: 'ANSWERED',
      duration: '00:03:00',
      seconds: '180',
      rate: '0.25',
      total: '0.7500',
      uniqueid,
    });
    cdrs.push(
      rec('v1', '2026-10-29 13:00:09', '3125550000'), // ours
      rec('v2', '2026-10-29 13:10:00', '3125551000'), // incoming, to our DID
      rec('v3', '2026-10-29 13:20:00', '01144207946095'), // not ours
      rec('v4', '2026-10-29 11:00:00', '01144207946096'), // before the window
      { ...rec('v5', '2026-10-29 13:30:00', '01144207946097'), account: '123456_other' },
    );
    await w.providerWatch();
    const q = seen.findLast((s) => s.get('method') === 'getCDR')!;
    expect(
      Object.fromEntries(['date_from', 'date_to', 'timezone', 'account'].map((k) => [k, q.get(k)])),
    ).toEqual({
      date_from: '2026-10-29',
      date_to: '2026-10-29',
      timezone: '0',
      account: '123456_pbx',
    });
    expect(mails.map((m) => m.subject)).toEqual([
      "voip.ms calls this phone system didn't make (1)",
    ]);
    expect(mails[0]!.text).toMatch(/to 01144207946095: answered, 180 s, cost 0\.7500/);
    expect(mails[0]!.text).not.toMatch(/3125550000|3125551000|946096|946097/);
    clock += 15 * 60_000;
    await w.providerWatch(); // v3 again: already reported
    expect(mails).toHaveLength(1);

    await setSetting(t.db, 'alerts.providerCalls', false);
    cdrs.push(rec('v6', '2026-10-29 14:00:00', '01144207946098'));
    clock += 15 * 60_000;
    await w.providerWatch();
    expect(mails).toHaveLength(1);
    await setSetting(t.db, 'alerts.providerCalls', true);
    cdrs.length = 0;
  });

  it('balanceWatch emails once an hour when the balance drops more than the limit', async () => {
    await setSetting(t.db, 'alerts.providerCalls', false);
    await setSetting(t.db, 'alerts.balanceDropPerHour', 10);
    const w = watch();
    mails.length = 0;
    clock = Date.parse('2026-10-29T16:00:00Z');
    balance = '100.00';
    await w.providerWatch();
    clock += 15 * 60_000;
    balance = '95.00';
    await w.providerWatch();
    expect(mails).toEqual([]);
    clock += 15 * 60_000;
    balance = '85.00';
    await w.providerWatch();
    expect(mails.map((m) => m.subject)).toEqual(['voip.ms balance dropped 15.00 in an hour']);
    clock += 15 * 60_000;
    balance = '70.00';
    await w.providerWatch(); // within the hour of the last email
    expect(mails).toHaveLength(1);
    clock += 60 * 60_000;
    balance = '200.00'; // a deposit
    await w.providerWatch();
    expect(mails).toHaveLength(1);
    await setSetting(t.db, 'alerts.providerCalls', true);
  });
});
