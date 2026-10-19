// SPDX-License-Identifier: AGPL-3.0-or-later
// M10-T4: POST /api/live/calls/:linkedid/spy (04 §7.3). The live call list and the desk phone check
// are stubbed; e2e m10-t4 runs it against Asterisk.
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActiveCall } from '@selfphoneng/shared';
import { auditLog } from '../src/db/schema.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const call: ActiveCall = {
  linkedid: '1792420000.10',
  startedAt: '2026-10-19T12:00:00.000Z',
  direction: 'inbound',
  from: { number: '13125551234' },
  to: { number: '101', name: 'Dan Doe' },
  state: 'talking',
  extensions: ['101'],
  channels: ['PJSIP/voipms-0000000a', 'PJSIP/101-0000000b'],
  recording: false,
};

describe.skipIf(!hasTestDb)('/api/live/calls/:linkedid/spy', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let deskOnline = true;
  const spy = (mode: string, linkedid = call.linkedid) =>
    req('POST', `/api/live/calls/${linkedid}/spy`, { mode });

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
    t.app.live.calls.list = () => [call];
    t.app.live.deskOnline = () => deskOnline;
  });
  afterAll(() => t?.close());

  it('needs an extension of my own', async () => {
    const r = await spy('listen');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/extension of your own/);
  });

  it('rings my desk phone running ChanSpy on the user leg, per mode; audited', async () => {
    const me = (await req('GET', '/api/auth/me')).json().user;
    await req('POST', '/api/extensions', { number: '199', name: 'Boss', userId: me.id });
    for (const [mode, opts] of [
      ['listen', 'qE'],
      ['whisper', 'qEw'],
      ['barge', 'qEB'],
    ] as const) {
      t.ami.actions.length = 0;
      const r = await spy(mode);
      expect(r.statusCode, r.body).toBe(200);
      expect(t.ami.actions).toEqual([
        expect.objectContaining({
          Action: 'Originate',
          Channel: 'PJSIP/199',
          Application: 'ChanSpy',
          Data: `PJSIP/101-0000000b,${opts}`,
        }),
      ]);
    }
    const logged = JSON.stringify(await t.db.select().from(auditLog));
    expect(logged).toContain("Whispered into a call 13125551234 → 101 (on 101's phone)");
  });

  it('refuses: bad mode, ended call, desk phone offline, no user leg', async () => {
    expect((await spy('record')).statusCode).toBe(400);
    expect((await spy('listen', '1792420000.99')).statusCode).toBe(404);
    deskOnline = false;
    expect((await spy('listen')).statusCode).toBe(409);
    deskOnline = true;
    const trunkOnly = { ...call, channels: ['PJSIP/voipms-0000000a', 'Local/550@sp-x-0001;2'] };
    t.app.live.calls.list = () => [trunkOnly];
    expect((await spy('listen')).statusCode).toBe(400);
    t.app.live.calls.list = () => [call];
  });
});
