// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T4: background jobs (04 §8): retention, trunk/disk/public IP watches.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { eq } from 'drizzle-orm';
import type { TrunkLive } from '@selfphoneng/shared';
import { createJobs, retentionCleanup, type JobDeps } from '../src/jobs.ts';
import { extensions, sessions, systemEvents, voicemailMessages } from '../src/db/schema.ts';
import { getSetting, setSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('background jobs', () => {
  const events = (code: string) =>
    t.db
      .select({ severity: systemEvents.severity, message: systemEvents.message })
      .from(systemEvents)
      .where(eq(systemEvents.code, code))
      .orderBy(systemEvents.id);
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (m: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let trunkId: string;
  let clock = Date.parse('2026-10-19T12:00:00Z');
  let reg: TrunkLive['registration'] = 'registered';
  const scanned: string[] = [];
  const deps = (): JobDeps => ({
    config: t.app.config,
    db: t.db,
    ami: t.ami,
    live: {
      amiConnected: true,
      snapshot: () => ({
        extensions: [],
        queues: [],
        parked: [],
        ami: { connected: true },
        trunks: [{ trunkId, registration: reg, reachable: true, lastChange: '' }],
      }),
    },
    generator: t.app.generator,
    voicemail: { scan: async (ext) => void scanned.push(ext) },
    send: t.app.sendMail,
    log: t.app.log,
    now: () => new Date(clock),
  });

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
    await req('POST', '/api/extensions', { number: '101', name: 'Dan' });
    const r = await req('POST', '/api/trunks', {
      name: 'voip.ms',
      serverHost: '127.0.0.1',
      username: '123456_pbx',
      password: 'Sub-account pw!',
    });
    trunkId = r.json().id;
  });
  afterAll(() => t.close());
  afterEach(() => vi.unstubAllGlobals());

  it('retention removes old voicemail through Asterisk, and expired sessions', async () => {
    const [ext] = await t.db.select().from(extensions).where(eq(extensions.number, '101'));
    const msg = (msgId: string, days: number) => ({
      extensionId: ext!.id,
      msgId,
      folder: 'INBOX',
      durationS: 3,
      receivedAt: new Date(Date.now() - days * 86_400_000),
      filePath: `default/101/INBOX/${msgId}.wav`,
    });
    await t.db.insert(voicemailMessages).values([msg('old-1', 40), msg('new-1', 2)]);
    const [u] = await t.db.select({ id: sessions.userId }).from(sessions);
    await t.db.insert(sessions).values({
      id: 'expired-session-hash',
      userId: u!.id,
      csrfToken: 'x',
      expiresAt: new Date(Date.now() - 1000),
    } as typeof sessions.$inferInsert);

    await setSetting(t.db, 'voicemail.retentionDays', 0); // 0 keeps voicemail
    t.ami.actions.length = 0;
    await retentionCleanup(deps());
    expect(t.ami.actions).toEqual([]);
    expect(
      await t.db.select().from(sessions).where(eq(sessions.id, 'expired-session-hash')),
    ).toEqual([]);

    await setSetting(t.db, 'voicemail.retentionDays', 30);
    await retentionCleanup(deps());
    expect(t.ami.actions).toEqual([
      {
        Action: 'VoicemailRemove',
        Context: 'default',
        Mailbox: '101',
        Folder: 'INBOX',
        ID: 'old-1',
      },
    ]);
    expect(scanned).toEqual(['101']);

    // The daily job waits for Asterisk (at start AMI connects a few seconds after the first run).
    await t.db.update(voicemailMessages).set({ deletedAt: null }); // fake scan: still there
    const j = createJobs(deps());
    t.ami.connected = false;
    t.ami.actions.length = 0;
    await j.daily();
    expect(t.ami.actions).toEqual([]);
    t.ami.connected = true;
    await j.daily();
    await j.daily(); // once a day
    expect(t.ami.actions.map((a) => a.ID)).toEqual(['old-1']);
  });

  it('trunkWatch emails admins once when a trunk is down for 5 minutes', async () => {
    const j = createJobs(deps());
    t.mails.length = 0;
    reg = 'rejected';
    await j.trunkWatch();
    clock += 4 * 60_000;
    await j.trunkWatch();
    expect(t.mails).toEqual([]);
    clock += 60_000;
    await j.trunkWatch();
    clock += 60_000;
    await j.trunkWatch();
    expect(t.mails.map((m) => [m.to, m.subject])).toEqual([
      [[ADMIN.email], 'Trunk voip.ms is down'],
    ]);
    // Back up, then down again: a new outage gets its own email.
    reg = 'registered';
    await j.trunkWatch();
    reg = 'unregistered';
    await j.trunkWatch();
    clock += 5 * 60_000;
    await j.trunkWatch();
    expect(t.mails).toHaveLength(2);
    // IP-auth trunks never register: never "down".
    reg = 'unknown';
    const k = createJobs(deps());
    await k.trunkWatch();
    clock += 10 * 60_000;
    await k.trunkWatch();
    expect(t.mails).toHaveLength(2);
  });

  it('publicIpWatch saves a changed IP, asks for a restart and emails admins', async () => {
    const j = createJobs(deps());
    vi.stubGlobal('fetch', async () => new Response('203.0.113.9\n'));
    t.mails.length = 0;
    await setSetting(t.db, 'network.publicIp', '203.0.113.5');
    await j.publicIpWatch(); // off by default
    expect(await getSetting(t.db, 'network.publicIp')).toBe('203.0.113.5');

    await setSetting(t.db, 'network.publicIpWatch', true);
    await j.publicIpWatch();
    expect(await getSetting(t.db, 'network.publicIp')).toBe('203.0.113.9');
    expect(await getSetting(t.db, 'system.restartRequired')).toBe(true);
    expect(t.mails.map((m) => m.subject)).toEqual(['Public IP changed to 203.0.113.9']);
    expect(await events('network.publicIpChanged')).toEqual([
      { severity: 'warning', message: 'Public IP changed from 203.0.113.5 to 203.0.113.9' },
    ]);

    await j.publicIpWatch(); // unchanged: nothing
    vi.stubGlobal('fetch', async () => new Response('<html>rate limited</html>'));
    await j.publicIpWatch(); // garbage answer: keep the old IP
    expect(await getSetting(t.db, 'network.publicIp')).toBe('203.0.113.9');
    expect(t.mails).toHaveLength(1);
  });

  it('diskWatch emails admins once a day under 10% free', async () => {
    let bavail = 50;
    const fake = (async () => ({
      bavail,
      blocks: 100,
      bsize: 1e9,
    })) as unknown as JobDeps['statfs'];
    const j = createJobs({ ...deps(), statfs: fake });
    t.mails.length = 0;
    await j.diskWatch();
    expect(t.mails).toEqual([]);
    bavail = 6;
    await j.diskWatch();
    await j.diskWatch();
    expect(t.mails.map((m) => [m.subject, m.text.split('.')[0]])).toEqual([
      ['Disk almost full (6% free)', 'Only 6 GB (6%) is free on the phone system'],
    ]);
    clock += 86_400_000; // next day: again
    await j.diskWatch();
    expect(t.mails).toHaveLength(2);
    expect(await events('disk.low')).toEqual([
      { severity: 'warning', message: 'Disk almost full: 6% free' },
      { severity: 'warning', message: 'Disk almost full: 6% free' },
    ]);
  });

  it('a mail that fails to send is logged, not thrown', async () => {
    t.mail.fail = 'smtp down';
    reg = 'rejected';
    const j = createJobs(deps());
    await j.trunkWatch();
    clock += 6 * 60_000;
    await expect(j.trunkWatch()).resolves.toBeUndefined();
    t.mail.fail = null;
  });
});
