// SPDX-License-Identifier: AGPL-3.0-or-later
// The System page (05 §2): status, the event log, and /api/about (08 §4, no sign-in).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { TrunkLive } from '@selfphoneng/shared';
import { encrypt } from '../src/crypto/secrets.ts';
import { systemEvents, trunks } from '../src/db/schema.ts';
import { logEvent, watchEvents } from '../src/services/events.ts';
import { setSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const settle = () => new Promise((r) => setTimeout(r, 200)); // inserts are fire-and-forget

describe.skipIf(!hasTestDb)('system status, event log, about', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let get: (url: string, cookie?: string) => Promise<LightMyRequestResponse>;
  let admin: string;

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    admin = await t.login(ADMIN.email, ADMIN.password);
    get = (url, cookie = admin) =>
      t.app.inject({ method: 'GET', url, headers: cookie ? { ...H, cookie } : H });
  });
  afterAll(() => t?.close());

  it('status: version, host, IPs, ports, telephony, restart', async () => {
    await setSetting(t.db, 'network.publicIp', '203.0.113.5');
    await setSetting(t.db, 'sip.tlsEnabled', true);
    const s = (await get('/api/system/status')).json();
    expect(s).toMatchObject({
      version: '0.0.0',
      hostname: expect.any(String),
      companyName: expect.any(String),
      publicIp: '203.0.113.5',
      publicIpDynamic: false,
      ports: { sip: 5060, sipTcp: true, sips: 5061, rtp: '10000–20000', https: 443 },
      ami: { connected: true },
      restartRequired: expect.any(Boolean),
    });
    expect(Array.isArray(s.lanIps)).toBe(true);
  });

  it('the watcher logs trunk changes, 911, Asterisk going away, config problems', async () => {
    watchEvents(t.db, t.live, t.ami, t.app.log);
    const [trunk] = await t.db
      .insert(trunks)
      .values({
        name: 'voip.ms',
        serverHost: 'x.voip.ms',
        username: 'u',
        passwordEnc: encrypt('p'),
      })
      .returning();
    const reg = (registration: TrunkLive['registration']) =>
      t.live.emit('message', {
        type: 'trunk.updated',
        data: { trunkId: trunk!.id, registration, reachable: true, lastChange: '' },
      });
    reg('registered'); // first sight: nothing
    reg('registered');
    reg('rejected');
    reg('registered');
    t.ami.events.emit('disconnected');
    t.ami.events.emit('connected');
    const call = { ext: '101', name: 'Ann', location: '2nd floor', callerId: '13125550100' };
    t.live.emit('message', {
      type: 'emergency.call',
      data: { ...call, at: '', test: false, audienceUserIds: [] },
    });
    t.live.emit('message', {
      type: 'emergency.call',
      data: { ...call, at: '', test: true, audienceUserIds: [] },
    });
    t.live.emit('message', {
      type: 'system.configApplied',
      data: { ok: true, error: null, restartRequired: true },
    });
    t.live.emit('message', {
      type: 'system.configApplied',
      data: { ok: false, error: 'disk full', restartRequired: true }, // already said: once
    });
    await settle();
    // Sorted: trunk events wait for the trunk's name, so they can land after later ones.
    const rows = (await t.db.select().from(systemEvents)).sort((x, y) =>
      x.code.localeCompare(y.code),
    );
    expect(rows.map((r) => [r.severity, r.code, r.source, r.message])).toEqual([
      [
        'error',
        'config.failed',
        'Configuration',
        "Writing Asterisk's configuration failed: disk full",
      ],
      [
        'error',
        'emergency.call',
        'Emergency',
        '101 Ann dialed 911 (caller ID 13125550100, 2nd floor)',
      ],
      ['info', 'emergency.test', 'Emergency', 'Emergency notifications tested'],
      [
        'error',
        'telephony.down',
        'Telephony',
        'Lost the connection to Asterisk (stopped or restarting)',
      ],
      [
        'warning',
        'telephony.restartNeeded',
        'Configuration',
        'SIP ports, transports or the public IP changed: telephony needs a restart',
      ],
      ['info', 'telephony.up', 'Telephony', 'Asterisk is reachable again'],
      [
        'warning',
        'trunk.down',
        'Trunk',
        'Trunk voip.ms was rejected (wrong username or password?)',
      ],
      ['info', 'trunk.up', 'Trunk', 'Trunk voip.ms registered'],
    ]);
  });

  it('events: newest first, paged; CSV; admins only', async () => {
    await t.db.delete(systemEvents);
    for (let i = 1; i <= 5; i++)
      await logEvent(t.db, {
        severity: 'info',
        code: 'test.n',
        source: 'Test',
        message: i === 5 ? '=cmd|x' : `event ${i}`,
      });
    const first = (await get('/api/system/events?limit=2')).json();
    expect(first.items.map((e: { message: string }) => e.message)).toEqual(['=cmd|x', 'event 4']);
    const second = (await get(`/api/system/events?limit=2&before=${first.nextCursor}`)).json();
    expect(second.items.map((e: { message: string }) => e.message)).toEqual(['event 3', 'event 2']);
    const last = (await get(`/api/system/events?limit=2&before=${second.nextCursor}`)).json();
    expect(last).toMatchObject({ items: [{ message: 'event 1' }], nextCursor: null });

    const csv = await get('/api/system/events.csv');
    expect(csv.headers['content-disposition']).toContain('selfphoneng-events.csv');
    const lines = csv.body.trim().split('\r\n');
    expect(lines[0]).toBe('time,severity,event,source,details');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toMatch(/,info,test\.n,Test,'=cmd\|x$/); // no spreadsheet formulas

    await t.addUser('pat@example.com', 'pat-password-123');
    const pat = await t.login('pat@example.com', 'pat-password-123');
    expect((await get('/api/system/events', pat)).statusCode).toBe(403);
    expect((await get('/api/system/events', '')).statusCode).toBe(401);
  });

  it('about needs no sign-in; outside a Docker build there is no source archive', async () => {
    const r = await get('/api/about', '');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      version: '0.0.0',
      repoUrl: 'https://git.dou.bet/spng/selfphoneng',
      source: null,
    });
    expect((await get('/api/about/source', '')).statusCode).toBe(404);
  });
});
