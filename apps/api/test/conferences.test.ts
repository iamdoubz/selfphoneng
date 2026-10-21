// SPDX-License-Identifier: AGPL-3.0-or-later
// M8-T3: /api/conferences (03 §6.11, 04 §7.3).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, conferences } from '../src/db/schema.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('/api/conferences', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let roomId: string;
  const conf = async (f: string) => {
    await t.app.generator.apply({ trigger: 'test' });
    return readFile(join(t.genDir, f), 'utf8');
  };

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
  });
  afterAll(() => t?.close());

  it('creates a room with PINs: stored encrypted, shown to admins, in the dialplan', async () => {
    const r = await req('POST', '/api/conferences', {
      number: '800',
      name: 'Board',
      pin: '4826',
      adminPin: '917355',
    });
    expect(r.statusCode, r.body).toBe(201);
    roomId = r.json().id;
    expect(r.json()).toMatchObject({
      pin: '4826',
      adminPin: '917355',
      maxMembers: 20,
      record: false,
    });
    const [row] = await t.db.select().from(conferences);
    expect(row!.pinEnc).not.toContain('4826');
    const d = await conf('extensions_selfphoneng.conf');
    expect(d).toContain(`exten => 800,1,Goto(sp-conf-${roomId},s,1)`);
    expect(d).toContain(' same => n,GotoIf($["${PIN}" = "917355"]?admin)');
    expect(d).toContain(' same => n(admin),ConfBridge(800,sp_room_800,sp_admin_user,default_menu)');
    expect(await conf('confbridge_selfphoneng.conf')).toContain('[sp_admin_user]');
    // the audit log says a PIN was set, not which
    const logged = JSON.stringify(await t.db.select().from(auditLog));
    expect(logged).not.toContain('4826');
    expect(logged).not.toContain('917355');
  });

  it('checks the number and the PINs', async () => {
    const bad = (body: object) =>
      req('POST', '/api/conferences', { number: '801', name: 'X', ...body });
    expect((await bad({ number: '700' })).statusCode).toBe(409); // the parking lot
    expect((await bad({ number: '800' })).statusCode).toBe(409);
    expect((await bad({ pin: '12' })).statusCode).toBe(400);
    expect((await bad({ pin: '12a4' })).statusCode).toBe(400);
    expect((await bad({ adminPin: '1234' })).statusCode).toBe(400); // admin PIN alone
    expect((await bad({ pin: '1234', adminPin: '1234' })).statusCode).toBe(400);
    expect((await bad({ maxMembers: 1 })).statusCode).toBe(400);
    // PATCH checks against what's stored: removing the room PIN keeps an admin PIN alone
    expect((await req('PATCH', `/api/conferences/${roomId}`, { pin: null })).statusCode).toBe(400);
  });

  it('no PIN: straight in; record: each caller is recorded once inside', async () => {
    const r = await req('PATCH', `/api/conferences/${roomId}`, {
      pin: null,
      adminPin: null,
      record: true,
      maxMembers: 5,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ pin: null, adminPin: null });
    const d = await conf('extensions_selfphoneng.conf');
    const ctx = d.slice(d.indexOf(`[sp-conf-${roomId}]`)).split('\n\n')[0]!;
    expect(ctx).not.toContain('Read(PIN');
    expect(await conf('confbridge_selfphoneng.conf')).toContain(
      '[sp_room_800](default_bridge)        ; room 800\nmax_members = 5',
    );
    expect(ctx).toContain(
      'Gosub(sp-sub-record,s,1)\n same => n,ConfBridge(800,sp_room_800,default_user',
    );
  });

  it('a phone number can point at it; delete is refused while it does', async () => {
    const trunkId = (
      await req('POST', '/api/trunks', {
        name: 'voip.ms',
        serverHost: '127.0.0.1',
        username: '123456_pbx',
        password: 'pw',
      })
    ).json().id;
    const did = await req('POST', '/api/dids', {
      number: '3125551234',
      trunkId,
      destination: { type: 'conference', id: roomId },
    });
    expect(did.json().destinationSummary).toBe('Conference Board (800)');
    expect((await req('DELETE', `/api/conferences/${roomId}`)).statusCode).toBe(409);
    await req('PATCH', `/api/dids/${did.json().id}`, { destination: { type: 'hangup' } });
    expect((await req('DELETE', `/api/conferences/${roomId}`)).statusCode).toBe(200);
    expect(await conf('extensions_selfphoneng.conf')).not.toContain('sp-conf-');
  });
});
