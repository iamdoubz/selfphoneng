// SPDX-License-Identifier: AGPL-3.0-or-later
// M3-T3: outbound routes, their order, the test box, and caller ID priority.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { patternRegex } from '@selfphoneng/shared';
import { settings } from '../src/db/schema.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe('patternRegex (Asterisk pattern rules)', () => {
  it.each([
    ['NXXNXXXXXX', '3125550000', true],
    ['NXXNXXXXXX', '1125550000', false], // N is 2-9
    ['1NXXNXXXXXX', '13125550000', true],
    ['1800NXXXXXX', '18005551234', true],
    ['011.', '011442079460958', true],
    ['011.', '011', false], // "." needs at least one more character
    ['011!', '011', true],
    ['9[2-9]XX', '9234', true],
    ['9[2-9]XX', '9134', false],
    ['ZXX', '011', false],
  ])('%s vs %s → %s', (p, n, ok) => expect(patternRegex(p).test(n)).toBe(ok));
});

describe.skipIf(!hasTestDb)('outbound routes API', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  const dialplan = () => readFileSync(join(t.genDir, 'extensions_selfphoneng.conf'), 'utf8');
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 60));
    await t.app.generator.apply({ trigger: 'test' });
  };
  let trunkId: string;
  let ext: { id: string };
  let local: { id: string };
  let mainDid: string;
  let salesDid: string;
  let routes: { id: string; name: string }[];
  const test = async (extensionId: string, number: string) =>
    (await req('POST', '/api/outbound-routes/test', { extensionId, number })).json();

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
    trunkId = (
      await req('POST', '/api/trunks', {
        name: 'voip.ms',
        serverHost: '127.0.0.1',
        username: '123456_pbx',
        password: 'pw',
      })
    ).json().id;
    ext = (await req('POST', '/api/extensions', { number: '101', name: 'Dan' })).json();
    local = (
      await req('POST', '/api/extensions', { number: '102', name: 'Lo', outboundClass: 'local' })
    ).json();
    mainDid = (
      await req('POST', '/api/dids', {
        number: '3125551234',
        trunkId,
        destination: { type: 'hangup' },
      })
    ).json().id;
    salesDid = (
      await req('POST', '/api/dids', {
        number: '3125559876',
        trunkId,
        destination: { type: 'hangup' },
      })
    ).json().id;
    await t.db.insert(settings).values({ key: 'routing.defaultCallerIdDidId', value: mainDid });
    routes = (await req('GET', '/api/outbound-routes')).json().items;
  });
  afterAll(() => t?.close());

  it('a 10-digit number goes out as 11 digits with the default caller ID', async () => {
    expect(await test(ext.id, '(312) 555-0000')).toEqual({
      ok: true,
      routeId: routes[1]!.id,
      routeName: 'Local and national (US/Canada)',
      pattern: 'NXXNXXXXXX',
      dialed: '13125550000',
      trunks: [{ id: trunkId, name: 'voip.ms' }],
      callerId: '(312) 555-1234',
    });
  });

  it('class local may call toll-free but not national; international is off', async () => {
    expect((await test(local.id, '18005551234')).ok).toBe(true);
    const denied = await test(local.id, '13125550000');
    expect(denied).toMatchObject({ ok: false, routeName: 'Local and national (US/Canada)' });
    expect(denied.reason).toMatch(/needs calling permission "national"/);
    expect(await test(ext.id, '011442079460958')).toEqual({
      ok: false,
      reason: 'No enabled route matches this number. The call fails.',
    });
    expect((await test(ext.id, '911')).reason).toMatch(/Emergency/);
    expect((await test(ext.id, '102')).reason).toMatch(/internal number/);
  });

  it('caller ID: the user setting beats the default, a route override beats both', async () => {
    await req('PATCH', `/api/extensions/${ext.id}`, { outboundCallerIdDidId: salesDid });
    expect((await test(ext.id, '3125550000')).callerId).toBe('(312) 555-9876');
    await req('PATCH', `/api/outbound-routes/${routes[1]!.id}`, { callerIdDidId: mainDid });
    expect((await test(ext.id, '3125550000')).callerId).toBe('(312) 555-1234');
    await req('PATCH', `/api/outbound-routes/${routes[1]!.id}`, { callerIdDidId: null });
  });

  it('turning international on, then reordering, changes what matches first', async () => {
    const intl = routes[2]!;
    await req('PATCH', `/api/outbound-routes/${intl.id}`, { enabled: true });
    expect((await test(ext.id, '011442079460958')).ok).toBe(false); // class national < international
    const catchAll = (
      await req('POST', '/api/outbound-routes', {
        name: 'Everything',
        patterns: [{ match: 'X.', strip: 0, prepend: '' }],
        requiredClass: 'local',
        trunkIds: [trunkId],
      })
    ).json();
    expect(catchAll.position).toBe(3);
    expect((await test(local.id, '13125550000')).routeName).toBe('Local and national (US/Canada)');
    const ids = [catchAll.id, ...routes.map((r) => r.id)];
    expect((await req('POST', '/api/outbound-routes/reorder', { ids })).statusCode).toBe(200);
    expect((await test(local.id, '13125550000')).routeName).toBe('Everything');

    await settle();
    const conf = dialplan();
    const order = [...conf.matchAll(/^include => sp-or-(\S+)/gm)].map((m) => m[1]);
    expect(order).toEqual(ids); // the include order is the position order
    expect(conf).toContain(`[sp-route-${catchAll.id}]`);
    expect(
      (await req('POST', '/api/outbound-routes/reorder', { ids: ids.slice(1) })).statusCode,
    ).toBe(400);
  });

  it('refuses unknown or repeated trunks and bad patterns', async () => {
    const base = {
      name: 'x',
      requiredClass: 'local',
      patterns: [{ match: 'X.', strip: 0, prepend: '' }],
    };
    const unknown = await req('POST', '/api/outbound-routes', {
      ...base,
      trunkIds: ['00000000-0000-4000-8000-000000000000'],
    });
    expect(unknown.statusCode).toBe(400);
    const twice = await req('POST', '/api/outbound-routes', {
      ...base,
      trunkIds: [trunkId, trunkId],
    });
    expect(twice.statusCode).toBe(400);
    const bad = await req('POST', '/api/outbound-routes', {
      ...base,
      trunkIds: [trunkId],
      patterns: [{ match: '9,Dial(x)', strip: 0, prepend: '' }],
    });
    expect(bad.statusCode).toBe(400);
  });
});
