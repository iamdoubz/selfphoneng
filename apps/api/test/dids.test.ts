// SPDX-License-Identifier: AGPL-3.0-or-later
// M3-T2: phone numbers, destinations (exist checks, references, summaries) and the inbound dialplan.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DidCreateSchema } from '@selfphoneng/shared';
import { settings } from '../src/db/schema.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe('DID number input', () => {
  it.each([
    ['(312) 555-1234', '13125551234'],
    ['312.555.1234', '13125551234'],
    ['+1 312 555 1234', '13125551234'],
    ['13125551234', '13125551234'],
    ['+44 20 7946 0958', '011442079460958'],
  ])('%s → %s', (input, out) => {
    const r = DidCreateSchema.safeParse({
      number: input,
      trunkId: '7d3e9a52-1c4b-4f6e-9a0d-2b8c5e1f4a37',
      destination: { type: 'hangup' },
    });
    expect(r.success && r.data.number).toBe(out);
  });

  it.each(['555-1234x', 'abc', '12'])('rejects %s', (input) => {
    expect(
      DidCreateSchema.safeParse({
        number: input,
        trunkId: '7d3e9a52-1c4b-4f6e-9a0d-2b8c5e1f4a37',
        destination: { type: 'hangup' },
      }).success,
    ).toBe(false);
  });
});

describe.skipIf(!hasTestDb)('DIDs API', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  const dialplan = () => readFileSync(join(t.genDir, 'extensions_selfphoneng.conf'), 'utf8');
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 60));
    await t.app.generator.apply({ trigger: 'test' });
  };
  let trunkId: string;
  let extId: string;
  let didId: string;

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
    extId = (await req('POST', '/api/extensions', { number: '101', name: 'Dan Doe' })).json().id;
  });
  afterAll(() => t?.close());

  it('adds a number routed to a user, normalized, with a readable summary', async () => {
    const r = await req('POST', '/api/dids', {
      number: '(312) 555-1234',
      trunkId,
      label: 'Main line',
      destination: { type: 'user', id: extId },
    });
    expect(r.statusCode).toBe(201);
    didId = r.json().id;
    expect(r.json()).toMatchObject({
      number: '13125551234',
      destinationSummary: 'Ring Dan Doe (101)',
    });
    await settle();
    const conf = dialplan();
    expect(conf).toContain('[sp-did-exists]\nexten => 13125551234,1,NoOp()');
    expect(conf).toContain(
      'exten => 13125551234,1,Set(__SP_DID=13125551234)\n same => n,Set(CDR(SP_DID)=13125551234)\n same => n,Goto(sp-local-numbers,101,1)',
    );
    expect(conf).toContain(`[sp-from-trunk-${trunkId}]`);
  });

  it('refuses duplicates, unknown trunks and destinations that do not exist', async () => {
    const dup = await req('POST', '/api/dids', {
      number: '3125551234',
      trunkId,
      destination: { type: 'hangup' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toBe('(312) 555-1234 is already added');
    const badTrunk = await req('POST', '/api/dids', {
      number: '3125550001',
      trunkId: '00000000-0000-4000-8000-000000000000',
      destination: { type: 'hangup' },
    });
    expect(badTrunk.statusCode).toBe(400);
    const badDest = await req('POST', '/api/dids', {
      number: '3125550001',
      trunkId,
      destination: { type: 'user', id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(badDest.statusCode).toBe(400);
  });

  it('an extension a number points at cannot be deleted (409 names the number)', async () => {
    const r = await req('DELETE', `/api/extensions/${extId}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.usedBy).toEqual(['number (312) 555-1234']);
    // A voicemail destination is a reference to the same extension.
    await req('PATCH', `/api/dids/${didId}`, { destination: { type: 'voicemail', id: extId } });
    expect((await req('DELETE', `/api/extensions/${extId}`)).statusCode).toBe(409);
  });

  it('the unmatched-number setting counts as a reference too', async () => {
    await req('PATCH', `/api/dids/${didId}`, {
      destination: { type: 'external', number: '13125550000' },
    });
    await t.db.insert(settings).values({
      key: 'routing.unmatchedDidDestination',
      value: { type: 'user', id: extId },
    });
    const r = await req('DELETE', `/api/extensions/${extId}`);
    expect(r.json().error.details.usedBy).toEqual(['the setting for calls to unknown numbers']);
    await settle();
    expect(dialplan()).toContain('exten => _[0-9a-z].,1,Goto(sp-local-numbers,101,1)');
    expect(dialplan()).toContain(' same => n,Goto(sp-ext-forward,13125550000,1)');
  });

  it('a caller-name prefix lands in the dialplan, sanitized by the schema', async () => {
    const bad = await req('PATCH', `/api/dids/${didId}`, { callerIdNamePrefix: 'X;Y' });
    expect(bad.statusCode).toBe(400);
    await req('PATCH', `/api/dids/${didId}`, { callerIdNamePrefix: 'SALES:' });
    await settle();
    expect(dialplan()).toContain(' same => n,Set(CALLERID(name)=SALES: ${CALLERID(name)})');
  });

  it('a number that is the emergency caller ID cannot be removed', async () => {
    await t.db.insert(settings).values({ key: 'emergency.defaultCallerIdDidId', value: didId });
    const r = await req('DELETE', `/api/dids/${didId}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toContain('the default emergency caller ID');
  });
});
