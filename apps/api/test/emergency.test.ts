// SPDX-License-Identifier: AGPL-3.0-or-later
// M3-T4: 911 notifications (04 §5.3), the test button, settings and dashboard warnings.
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveMessage } from '@selfphoneng/shared';
import { emergencyEvents, settings } from '../src/db/schema.ts';
import { decrypt } from '../src/crypto/secrets.ts';
import { watchEmergencies } from '../src/services/emergency.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const tick = () => new Promise((r) => setTimeout(r, 50));

describe.skipIf(!hasTestDb)('emergency notifications', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let dan: { id: string; number: string };
  let desk: { id: string; number: string };
  let didId: string;
  const live: LiveMessage[] = [];

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
    dan = (await req('POST', '/api/extensions', { number: '101', name: 'Dan Doe' })).json();
    await req('PATCH', `/api/extensions/${dan.id}`, { emergencyLocation: '2nd floor, room 210' });
    desk = (await req('POST', '/api/extensions', { number: '100', name: 'Front desk' })).json();
    const trunkId = (
      await req('POST', '/api/trunks', {
        name: 'voip.ms',
        serverHost: '127.0.0.1',
        username: '123456_pbx',
        password: 'pw',
      })
    ).json().id;
    didId = (
      await req('POST', '/api/dids', {
        number: '3125551234',
        trunkId,
        destination: { type: 'hangup' },
      })
    ).json().id;
    t.live.on('message', (m) => live.push(m));
    watchEmergencies(
      { db: t.db, ami: t.ami, live: t.live, send: t.app.sendMail, log: t.app.log },
      t.ami.events,
    );
  });
  afterAll(() => t?.close());

  it('dashboard warnings: E911 caller ID missing, email missing', async () => {
    const codes = (await req('GET', '/api/system/warnings'))
      .json()
      .items.map((w: { code: string }) => w.code);
    expect(codes).toEqual(['e911_cid_missing', 'smtp_missing']);
  });

  it('settings: SMTP password is write-only; references are checked', async () => {
    const r = await req('PATCH', '/api/settings', {
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        username: 'pbx',
        password: 'mail-secret',
        from: 'PBX <pbx@example.com>',
      },
      'emergency.defaultCallerIdDidId': didId,
      'emergency.notifyEmails': ['security@example.com'],
      'emergency.notifyExtensionIds': [desk.id],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().smtp).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      username: 'pbx',
      from: 'PBX <pbx@example.com>',
      hasPassword: true,
    });
    expect(JSON.stringify(r.json())).not.toContain('mail-secret');
    const [row] = await t.db.select().from(settings).where(eq(settings.key, 'smtp'));
    expect(decrypt((row!.value as { passwordEnc: string }).passwordEnc)).toBe('mail-secret');
    // Saving again without a password keeps it.
    await req('PATCH', '/api/settings', {
      smtp: { ...r.json().smtp, hasPassword: undefined, port: 465, secure: true },
    });
    const [again] = await t.db.select().from(settings).where(eq(settings.key, 'smtp'));
    expect(decrypt((again!.value as { passwordEnc: string }).passwordEnc)).toBe('mail-secret');

    for (const bad of [
      { 'system.restartRequired': false },
      { 'no.such.key': 1 },
      { 'emergency.defaultCallerIdDidId': '00000000-0000-4000-8000-000000000000' },
      { 'emergency.notifyExtensionIds': ['00000000-0000-4000-8000-000000000000'] },
      { 'emergency.notifyEmails': ['not-an-email'] },
    ])
      expect((await req('PATCH', '/api/settings', bad)).statusCode).toBe(400);

    const codes = (await req('GET', '/api/system/warnings'))
      .json()
      .items.map((w: { code: string }) => w.code);
    expect(codes).toEqual(['e911_address_unconfirmed']);
    await req('PATCH', `/api/dids/${didId}`, { e911Address: '1 Main St, Chicago IL' });
    expect((await req('GET', '/api/system/warnings')).json().items).toEqual([]);
  });

  it('a 911 call records the event, emails, rings the notify phone and tells the dashboards', async () => {
    t.ami.events.emit('event', {
      Event: 'UserEvent',
      UserEvent: 'SpEmergency',
      Ext: '101',
      CallerId: '13125551234',
      Dialed: '911',
    });
    for (let i = 0; i < 40 && !(await t.db.select().from(emergencyEvents))[0]?.notified; i++)
      await tick();
    await tick();
    const [ev] = await t.db.select().from(emergencyEvents);
    expect(ev).toMatchObject({
      extensionNumber: '101',
      dialed: '911',
      callerIdUsed: '13125551234',
      location: '2nd floor, room 210',
    });
    expect(ev!.notified).toEqual(
      expect.arrayContaining([
        { kind: 'email', to: 'security@example.com', ok: true },
        { kind: 'ring', to: '100', ok: true },
      ]),
    );
    const mail = t.mails.at(-1)!;
    expect(mail.subject).toBe('EMERGENCY: 911 dialed from ext 101 (Dan Doe)');
    expect(mail.text).toContain('Location: 2nd floor, room 210');
    expect(t.ami.actions).toContainEqual(
      expect.objectContaining({
        Action: 'Originate',
        Channel: 'PJSIP/100',
        Context: 'sp-emergency-alert',
        Exten: '101',
      }),
    );
    expect(live).toContainEqual(
      expect.objectContaining({
        type: 'emergency.call',
        data: expect.objectContaining({ ext: '101', test: false, location: '2nd floor, room 210' }),
      }),
    );
  });

  it('a failing email is recorded and the phone still rings', async () => {
    t.mail.fail = 'connection refused';
    t.ami.actions.length = 0;
    t.ami.events.emit('event', {
      Event: 'UserEvent',
      UserEvent: 'SpEmergency',
      Ext: '101',
      CallerId: '13125551234',
      Dialed: '911',
    });
    for (let i = 0; i < 40 && (await t.db.select().from(emergencyEvents)).length < 2; i++)
      await tick();
    await tick();
    const rows = await t.db.select().from(emergencyEvents);
    const last = rows.find((r) =>
      (r.notified as unknown[]).some((n) => (n as { ok: boolean }).ok === false),
    );
    expect(last?.notified).toEqual(
      expect.arrayContaining([
        { kind: 'email', to: 'security@example.com', ok: false, error: 'connection refused' },
        { kind: 'ring', to: '100', ok: true },
      ]),
    );
    t.mail.fail = null;
  });

  it('the test button notifies with TEST in front, records nothing and dials nothing', async () => {
    const before = (await t.db.select().from(emergencyEvents)).length;
    t.ami.actions.length = 0;
    const r = await req('POST', '/api/settings/emergency/test');
    expect(r.statusCode).toBe(200);
    expect(t.mails.at(-1)!.subject).toMatch(/^TEST EMERGENCY: 911 dialed/);
    expect(t.mails.at(-1)!.text).toContain('No emergency call was made');
    expect(t.ami.actions).toEqual([
      expect.objectContaining({ Channel: 'PJSIP/100', Context: 'sp-emergency-alert' }),
    ]);
    expect((await t.db.select().from(emergencyEvents)).length).toBe(before);
  });
});
