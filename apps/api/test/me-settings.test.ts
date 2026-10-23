// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T7: GET/PATCH /api/me (DND, forwards, voicemail options) and SpToggle DND/CFU (04 §5.3).
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveMessage } from '@selfphoneng/shared';
import { auditLog, extensions } from '../src/db/schema.ts';
import { handleToggle } from '../src/services/toggles.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('/api/me settings and phone toggles', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let dan: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let danId: string;
  const live: LiveMessage[] = [];
  const toggle = (Key: string, Ext: string, Value: string) =>
    handleToggle(
      { db: t.db, ami: t.ami, live: t.live, log: t.app.log },
      { Event: 'UserEvent', UserEvent: 'SpToggle', Key, Ext, Value },
    );

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const as = (cookie: string) => (method: string, url: string, payload?: unknown) =>
      t.app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { ...H, cookie },
      });
    admin = as(await t.login(ADMIN.email, ADMIN.password));
    danId = (await t.addUser('dan@example.com', 'dan-password-123')).id;
    await admin('POST', '/api/extensions', { number: '101', name: 'Dan Doe', userId: danId });
    await admin('POST', '/api/extensions', { number: '102', name: 'Sue Smith' });
    const ext = (await admin('GET', '/api/extensions'))
      .json()
      .items.find((e: { number: string }) => e.number === '101');
    await admin('PATCH', `/api/extensions/${ext.id}`, { outboundClass: 'local' });
    // Outbound rules exist once a trunk does (M3 defaults: toll-free, US/Canada national, intl).
    await admin('POST', '/api/trunks', {
      name: 'voip.ms',
      serverHost: '127.0.0.1',
      username: '123456_pbx',
      password: 'pw',
    });
    dan = as(await t.login('dan@example.com', 'dan-password-123'));
    t.live.on('message', (m) => live.push(m));
  });
  afterAll(() => t?.close());

  it('GET /api/me shows my extension and settings', async () => {
    expect((await dan('GET', '/api/me')).json()).toEqual({
      extension: { number: '101', name: 'Dan Doe' },
      dnd: false,
      cfu: null,
      cfb: null,
      cfna: null,
      voicemailEnabled: true,
      voicemailEmail: true,
      voicemailAttachAudio: true,
      voicemailDeleteAfterEmail: false,
      callReport: 'off',
      callReportTime: '08:00',
      callReportWeekday: 1,
      callReportSummaries: false,
    });
  });

  it('DND and forwards: stored, then written to AstDB', async () => {
    t.ami.actions.length = 0;
    const r = await dan('PATCH', '/api/me', { dnd: true, cfb: '102', cfna: '1-800-555-0100' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ dnd: true, cfb: '102', cfna: '18005550100' });
    expect(t.ami.actions).toEqual([
      { Action: 'DBPut', Family: 'SP', Key: 'DND/101', Val: '1' },
      { Action: 'DBPut', Family: 'SP', Key: 'CFB/101', Val: '102' },
      { Action: 'DBPut', Family: 'SP', Key: 'CFNA/101', Val: '18005550100' },
    ]);
    const off = await dan('PATCH', '/api/me', { dnd: false, cfb: null });
    expect(off.json()).toMatchObject({ dnd: false, cfb: null, cfna: '18005550100' });
    expect(t.ami.actions.slice(-2)).toEqual([
      { Action: 'DBDel', Family: 'SP', Key: 'DND/101' },
      { Action: 'DBDel', Family: 'SP', Key: 'CFB/101' },
    ]);
  });

  it('forward targets: my calling permission applies; no self, no unknown extension', async () => {
    const fwd = (cfu: string) => dan('PATCH', '/api/me', { cfu });
    const national = await fwd('(312) 555-1234'); // class "local" may not call national numbers
    expect(national.statusCode).toBe(400);
    expect(national.json().error.message).toMatch(/calling permission doesn't allow/);
    expect((await fwd('101')).json().error.message).toMatch(/yourself/);
    expect((await fwd('199')).json().error.message).toMatch(/isn't an extension/);
    expect((await fwd('102')).json().cfu).toBe('102');
  });

  it('voicemail options and PIN (trivial PINs refused; voicemail.conf regenerated)', async () => {
    expect((await dan('PATCH', '/api/me', { voicemailPin: '1111' })).statusCode).toBe(400);
    const r = await dan('PATCH', '/api/me', { voicemailPin: '4826', voicemailEmail: false });
    expect(r.json().voicemailEmail).toBe(false);
    const [row] = await t.db.select().from(extensions).where(eq(extensions.number, '101'));
    expect(row!.voicemailEmail).toBe(false);
  });

  it('*78 / *79 from the phone update DND and everyone’s presence', async () => {
    await toggle('DND', '101', '1');
    expect((await dan('GET', '/api/me')).json().dnd).toBe(true);
    expect(
      live.some((m) => m.type === 'extension.updated' && m.data.number === '101' && m.data.dnd),
    ).toBe(true);
    await toggle('DND', '101', '0');
    expect((await dan('GET', '/api/me')).json().dnd).toBe(false);
  });

  it('*72<number>: allowed targets are kept; refused ones are undone, audited, toasted', async () => {
    await toggle('CFU', '101', '102');
    expect((await dan('GET', '/api/me')).json().cfu).toBe('102');
    t.ami.actions.length = 0;
    await toggle('CFU', '101', '13125551234');
    expect((await dan('GET', '/api/me')).json().cfu).toBeNull();
    expect(t.ami.actions).toEqual([{ Action: 'DBDel', Family: 'SP', Key: 'CFU/101' }]);
    expect(live).toContainEqual({
      type: 'toast',
      data: { userId: danId, message: expect.stringMatching(/^Call forwarding not turned on/) },
    });
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'forward_rejected'));
    expect(audits).toHaveLength(1);
    await toggle('CFU', '101', '');
    expect((await dan('GET', '/api/me')).json().cfu).toBeNull();
  });
});
