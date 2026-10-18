// SPDX-License-Identifier: AGPL-3.0-or-later
// M3-T1: trunks CRUD, generated PJSIP, and registration status replayed from a real Asterisk 24
// session against a fake provider (trunk-test.ts --record): one trunk registers, one is rejected.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TrunkCreateSchema, type LiveMessage } from '@selfphoneng/shared';
import { AmiParser, field } from '../src/ami/events.ts';
import { decrypt } from '../src/crypto/secrets.ts';
import { auditLog, dids, trunks } from '../src/db/schema.ts';
import { trunkOfObject } from '../src/live/state.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const MSGS = new AmiParser().push(
  readFileSync(new URL('./fixtures/ami/trunk-registration.raw', import.meta.url), 'latin1'),
);
const GOOD = '7d3e9a52-1c4b-4f6e-9a0d-2b8c5e1f4a37';
const BAD = '0b9f6c21-8e4d-4a7b-b3c5-d1e2f3a4b5c6';
const reply = (id: string) => MSGS.filter((m) => field(m, 'ActionID') === id && m.Event);
const LIVE_EVENTS = MSGS.filter((m) => m.Event && !m.ActionID);

describe('trunk schema', () => {
  const base = { name: 'voip.ms', serverHost: 'chicago1.voip.ms' };
  it('registration needs a username and password; IP auth does not', () => {
    expect(TrunkCreateSchema.safeParse(base).success).toBe(false);
    expect(TrunkCreateSchema.safeParse({ ...base, authMode: 'ip' }).success).toBe(true);
    expect(
      TrunkCreateSchema.safeParse({ ...base, username: '123456_pbx', password: 'pw' }).success,
    ).toBe(true);
  });

  it.each([
    ['password with ;', { password: 'a;b' }],
    ['password with a newline', { password: 'a\nb' }],
    ['password with an edge space', { password: ' ab' }],
    ['username with @', { username: 'a@b' }],
    ['host with a space', { serverHost: 'chicago1 .voip.ms' }],
    ['SRTP over UDP', { srtp: true }],
    ['unknown codec', { codecs: ['opus'] }],
  ])('rejects %s', (_, patch) => {
    const r = TrunkCreateSchema.safeParse({
      ...base,
      username: '123456_pbx',
      password: 'pw',
      ...patch,
    });
    expect(r.success).toBe(false);
  });

  it('maps Asterisk object names to trunk ids', () => {
    expect(trunkOfObject(`trunk-${GOOD}`)).toBe(GOOD);
    expect(trunkOfObject(`trunk-${GOOD}-reg`)).toBe(GOOD);
    expect(trunkOfObject(`trunk-${GOOD}-auth`)).toBeNull();
    expect(trunkOfObject('101')).toBeNull();
  });
});

describe.skipIf(!hasTestDb)('trunks API', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let req: (
    method: string,
    url: string,
    payload?: unknown,
    cookie?: string,
  ) => Promise<LightMyRequestResponse>;
  const pjsip = () => readFileSync(join(t.genDir, 'pjsip_selfphoneng.conf'), 'utf8');
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 60));
    await t.app.generator.apply({ trigger: 'test' });
  };
  let id: string;
  const voipms = {
    name: 'voip.ms',
    serverHost: '127.0.0.1', // an IP: no DNS lookup in tests
    username: '123456_pbx',
    password: 'Sub-account pw!',
  };

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    admin = await t.login(ADMIN.email, ADMIN.password);
    req = (method, url, payload, cookie = admin) =>
      t.app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { ...H, cookie },
      });
  });
  afterAll(() => t?.close());

  it('is admin only', async () => {
    await t.addUser('u@example.com', 'user-password-123');
    const user = await t.login('u@example.com', 'user-password-123');
    expect((await req('GET', '/api/trunks', undefined, user)).statusCode).toBe(403);
  });

  it('creates a voip.ms trunk with defaults; the password is stored encrypted and never returned', async () => {
    const r = await req('POST', '/api/trunks', voipms);
    expect(r.statusCode).toBe(201);
    const dto = r.json();
    id = dto.id;
    expect(dto).toMatchObject({
      provider: 'voipms',
      serverPort: 5060,
      transport: 'udp',
      authMode: 'registration',
      codecs: ['ulaw'],
      hasPassword: true,
      hasApiPassword: false,
    });
    expect(JSON.stringify(dto)).not.toContain('Sub-account pw!');
    const [row] = await t.db.select().from(trunks).where(eq(trunks.id, id));
    expect(decrypt(row!.passwordEnc!)).toBe('Sub-account pw!');
    const [a] = await t.db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(JSON.stringify(a)).not.toContain('Sub-account pw!');

    await settle();
    const conf = pjsip();
    expect(conf).toContain(`[trunk-${id}-reg]`);
    expect(conf).toContain(`client_uri = sip:123456_pbx@127.0.0.1:5060`);
    expect(conf).toContain(`password = Sub-account pw!`);
    expect(conf).toContain(`context = sp-from-trunk-${id}`);
  });

  it('refuses duplicates, transports that are off, and servers that do not resolve', async () => {
    expect((await req('POST', '/api/trunks', voipms)).statusCode).toBe(409);
    const tls = await req('POST', '/api/trunks', { ...voipms, name: 'tls', transport: 'tls' });
    expect(tls.statusCode).toBe(400);
    expect(tls.json().error.message).toMatch(/TLS/);
    const dns = await req('POST', '/api/trunks', {
      ...voipms,
      name: 'typo',
      serverHost: 'no-such-host.invalid',
    });
    expect(dns.statusCode).toBe(400);
    expect(dns.json().error.message).toMatch(/Can't find the server/);
  });

  it('updates keep the stored password unless a new one is given; disabling removes the config', async () => {
    const r = await req('PATCH', `/api/trunks/${id}`, { maxChannels: 4, codecs: ['ulaw', 'alaw'] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ maxChannels: 4, hasPassword: true });
    await settle();
    expect(pjsip()).toContain('allow = ulaw,alaw');
    expect(pjsip()).toContain('password = Sub-account pw!');

    await req('PATCH', `/api/trunks/${id}`, { enabled: false });
    await settle();
    expect(pjsip()).not.toContain(`trunk-${id}`);
    await req('PATCH', `/api/trunks/${id}`, { enabled: true });
  });

  it('refuses to delete a trunk that a phone number uses', async () => {
    const [d] = await t.db
      .insert(dids)
      .values({ number: '13125551234', trunkId: id, destination: { type: 'hangup' } })
      .returning();
    const r = await req('DELETE', `/api/trunks/${id}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toContain('number 13125551234');
    await t.db.delete(dids).where(eq(dids.id, d!.id));
    expect((await req('DELETE', `/api/trunks/${id}`)).statusCode).toBe(200);
    await settle();
    expect(pjsip()).not.toContain('trunk-');
  });
});

describe.skipIf(!hasTestDb)('trunk live state (recorded session)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    t = await createTestApp();
    for (const [tid, name] of [
      [GOOD, 'voip.ms'],
      [BAD, 'wrong password'],
    ] as const)
      await t.db.insert(trunks).values({ id: tid, name, serverHost: 'sp-trunk-provider' });
    t.ami.lists.PJSIPShowRegistrationsOutbound = reply('rec-2');
    t.ami.lists.PJSIPShowEndpoint = reply('rec-4');
  });
  afterAll(() => t?.close());

  it('loads registration and reachability on connect', async () => {
    await t.live.loadFromAsterisk();
    const byId = Object.fromEntries(t.live.snapshot(true).trunks!.map((x) => [x.trunkId, x]));
    expect(byId[GOOD]).toMatchObject({ registration: 'registered', reachable: true });
    expect(byId[BAD]).toMatchObject({ registration: 'rejected', reachable: true }); // canned reply
    expect(t.live.snapshot(false).trunks).toBeUndefined(); // users never see trunks
  });

  it('follows Registry and ContactStatus events', async () => {
    t.ami.lists.PJSIPShowRegistrationsOutbound = [];
    const msgs: LiveMessage[] = [];
    t.live.on('message', (m) => msgs.push(m));
    for (const m of LIVE_EVENTS) t.live.handleEvent(m); // replays two Registry events
    await new Promise((r) => setTimeout(r, 20));
    const trunk = (tid: string) => t.live.snapshot(true).trunks!.find((x) => x.trunkId === tid)!;
    expect(trunk(GOOD).registration).toBe('unknown'); // re-read: the canned list is now empty
    t.live.handleEvent({
      Event: 'ContactStatus',
      ContactStatus: 'Unreachable',
      AOR: `trunk-${GOOD}`,
      EndpointName: `trunk-${GOOD}`,
      URI: 'sip:sp-trunk-provider:5060',
    });
    expect(trunk(GOOD).reachable).toBe(false);
    expect(msgs.some((m) => m.type === 'trunk.updated' && m.data.trunkId === GOOD)).toBe(true);
    expect(msgs.some((m) => m.type === 'extension.updated')).toBe(false);
  });

  it('POST /:id/test qualifies the trunk and explains the result', async () => {
    t.ami.lists.PJSIPShowRegistrationsOutbound = reply('rec-2');
    t.live.amiConnected = true;
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/trunks/${GOOD}/test`,
      headers: { ...H, cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      registration: 'registered',
      rttMs: 1,
      detail: 'Registered with sp-trunk-provider',
    });
    expect(t.ami.actions).toContainEqual({ Action: 'PJSIPQualify', Endpoint: `trunk-${GOOD}` });
    const bad = await t.app.inject({
      method: 'POST',
      url: `/api/trunks/${BAD}/test`,
      headers: { ...H, cookie },
    });
    expect(bad.json().detail).toBe('sp-trunk-provider rejected the username or password');
  });
});
