// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T4: /api/time-conditions, /api/holidays, override codes (03 §6.10, §6.13, 04 §5.3, §5.5).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timeConditions } from '../src/db/schema.ts';
import { handleToggle } from '../src/services/toggles.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('office hours and holidays', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let dan: string;
  let id: string;
  const dialplan = async () => {
    await t.app.generator.apply({ trigger: 'test' });
    return readFile(join(t.genDir, 'extensions_selfphoneng.conf'), 'utf8');
  };
  const weekdays = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '17:00' };

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
  });
  afterAll(() => t?.close());

  it('creates office hours (company time zone by default) with a live status', async () => {
    const r = await req('POST', '/api/time-conditions', {
      name: 'Business hours',
      openRanges: [weekdays],
      overrideDigit: 1,
      openDestination: { type: 'user', id: dan },
      closedDestination: { type: 'voicemail', id: dan },
    });
    expect(r.statusCode, r.body).toBe(201);
    id = r.json().id;
    expect(r.json()).toMatchObject({
      timezone: 'America/Chicago',
      useHolidays: true,
      overrideState: null,
      holidayDestination: null,
      status: { reason: 'hours' },
    });
    const conf = await dialplan();
    expect(conf).toContain(`[sp-tc-${id}]`);
    expect(conf).toContain('GotoIfTime(08:00-16:59,mon&tue&wed&thu&fri,*,*,America/Chicago?open)');
    expect(conf).toContain(`exten => *311,1,Set(DB(SP/TCOVR/${id})=open)`);
  });

  it('validates ranges, time zone, digit and destinations', async () => {
    const post = (body: object) =>
      req('POST', '/api/time-conditions', {
        name: 'X',
        openDestination: { type: 'hangup' },
        closedDestination: { type: 'hangup' },
        ...body,
      });
    expect(
      (await post({ openRanges: [{ ...weekdays, start: '17:00', end: '08:00' }] })).statusCode,
    ).toBe(400);
    expect((await post({ openRanges: [{ ...weekdays, end: '25:00' }] })).statusCode).toBe(400);
    expect((await post({ timezone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await post({ overrideDigit: 1 })).statusCode).toBe(409);
    const self = await req('PATCH', `/api/time-conditions/${id}`, {
      closedDestination: { type: 'time_condition', id },
    });
    expect(self.statusCode).toBe(400);
  });

  it('force closed / automatic: database, AstDB and status follow', async () => {
    const closed = await req('POST', `/api/time-conditions/${id}/override`, { state: 'closed' });
    expect(closed.json()).toMatchObject({
      overrideState: 'closed',
      status: { now: 'closed', reason: 'override' },
    });
    expect(t.ami.actions.at(-1)).toEqual({
      Action: 'DBPut',
      Family: 'SP',
      Key: `TCOVR/${id}`,
      Val: 'closed',
    });
    const auto = await req('POST', `/api/time-conditions/${id}/override`, { state: 'auto' });
    expect(auto.json().overrideState).toBeNull();
    expect(t.ami.actions.at(-1)).toEqual({ Action: 'DBDel', Family: 'SP', Key: `TCOVR/${id}` });
  });

  it('*311 from a phone (SpToggle TCOVR) updates the database', async () => {
    await handleToggle(
      { db: t.db, log: t.app.log },
      { Event: 'UserEvent', UserEvent: 'SpToggle', Key: 'TCOVR', Id: id, Value: 'open' },
    );
    const [row] = await t.db.select().from(timeConditions).where(eq(timeConditions.id, id));
    expect(row!.overrideState).toBe('open');
    await handleToggle(
      { db: t.db, log: t.app.log },
      { Event: 'UserEvent', UserEvent: 'SpToggle', Key: 'TCOVR', Id: id, Value: 'auto' },
    );
    expect((await req('GET', `/api/time-conditions/${id}`)).json().overrideState).toBeNull();
  });

  it('holidays: add, US federal import (no duplicates), they reach the dialplan', async () => {
    const bad = await req('POST', '/api/holidays', {
      name: 'Backwards',
      startDate: '2026-12-26',
      endDate: '2026-12-24',
    });
    expect(bad.statusCode).toBe(400);
    const xmas = await req('POST', '/api/holidays', {
      name: 'Christmas',
      startDate: '2026-12-25',
      endDate: '2026-12-25',
      recurringYearly: true,
    });
    expect(xmas.statusCode).toBe(201);
    expect((await req('POST', '/api/holidays/import-us-federal', { year: 2026 })).json()).toEqual({
      added: 10, // Christmas (Dec 25) is already listed
    });
    expect((await req('POST', '/api/holidays/import-us-federal', { year: 2026 })).json()).toEqual({
      added: 0,
    });
    expect((await req('GET', '/api/holidays')).json().items).toHaveLength(11);
    const conf = await dialplan();
    expect(conf).toContain('GotoIfTime(*,*,25,dec,America/Chicago?holiday)');
    expect(conf).toContain('GotoIfTime(*,*,26,nov,America/Chicago?holiday)'); // Thanksgiving
  });

  it('delete is refused while a phone number points at it', async () => {
    const trunkId = (
      await req('POST', '/api/trunks', {
        name: 'voip.ms',
        serverHost: '127.0.0.1',
        username: '123456_pbx',
        password: 'pw',
      })
    ).json().id;
    const did = (
      await req('POST', '/api/dids', {
        number: '3125551234',
        trunkId,
        destination: { type: 'time_condition', id },
      })
    ).json();
    expect(did.destinationSummary).toBe('Office hours Business hours');
    expect((await req('DELETE', `/api/time-conditions/${id}`)).statusCode).toBe(409);
    await req('PATCH', `/api/dids/${did.id}`, { destination: { type: 'hangup' } });
    expect((await req('DELETE', `/api/time-conditions/${id}`)).statusCode).toBe(200);
  });
});
