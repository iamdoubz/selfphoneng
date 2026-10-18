// SPDX-License-Identifier: AGPL-3.0-or-later
// M2-T6: live state replayed from a real Asterisk 24 session (call-test.ts --record): phones 101
// and 102 register, 102 calls 101 for 30 s, both hang up. Plus the /api/live WebSocket.
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveMessage } from '@selfphoneng/shared';
import { AmiParser, field, type AmiMessage } from '../src/ami/events.ts';
import { encrypt, setSecretKey } from '../src/crypto/secrets.ts';
import type { Db } from '../src/db/client.ts';
import { extensions, userRuntimeState } from '../src/db/schema.ts';
import { LiveState, extOfEndpoint, stateFromStatus } from '../src/live/state.ts';
import { createTestDb, hasTestDb } from './db.ts';
import { ADMIN, createTestApp } from './app.ts';

const RAW = readFileSync(
  new URL('./fixtures/ami/register-and-call.raw', import.meta.url),
  'latin1',
);
const MSGS = new AmiParser().push(RAW);
const listOf = (actionId: string, event: string) =>
  MSGS.filter((m) => field(m, 'ActionID') === actionId && field(m, 'Event') === event);
// Events that weren't list items, in the order Asterisk sent them.
const LIVE_EVENTS = MSGS.filter((m) => m.Event && !m.ActionID);

describe('state mapping', () => {
  it.each([
    [0, 'idle'],
    [1, 'inuse'],
    [2, 'busy'],
    [4, 'unavailable'],
    [8, 'ringing'],
    [9, 'ringinuse'],
    [16, 'onhold'],
    [17, 'onhold'],
    [-1, 'unavailable'],
  ])('Status %i → %s', (n, s) => expect(stateFromStatus(n)).toBe(s));

  it('maps endpoints to extensions', () => {
    expect(extOfEndpoint('101')).toBe('101');
    expect(extOfEndpoint('101-web')).toBe('101');
    expect(extOfEndpoint('trunk-3f2a')).toBeNull();
  });
});

describe.skipIf(!hasTestDb)('LiveState with a recorded session', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    setSecretKey(Buffer.alloc(32, 9).toString('base64'));
    for (const [number, name] of [
      ['101', 'Alice'],
      ['102', 'Bob'],
      ['103', 'Carol'],
    ] as const) {
      const [e] = await db
        .insert(extensions)
        .values({ number, name, sipPasswordEnc: encrypt('x'), voicemailPinEnc: encrypt('1234') })
        .returning();
      await db.insert(userRuntimeState).values({ extensionId: e!.id, dnd: number === '103' });
    }
  });
  afterAll(() => drop?.());

  it('loads states and devices, then follows a whole call', async () => {
    const events = new EventEmitter();
    const ami = {
      on: events.on.bind(events),
      action: async () => ({}),
      actionList: async (f: Record<string, string>): Promise<AmiMessage[]> =>
        f.Action === 'PJSIPShowContacts'
          ? listOf('rec-2', 'ContactList')
          : listOf('rec-3', 'ExtensionStatus'),
    };
    const live = new LiveState(db, ami);
    const seen: Record<string, string[]> = { '101': [], '102': [] };
    live.on('message', (m: LiveMessage) => {
      if (m.type === 'extension.updated' && seen[m.data.number]) {
        const s = seen[m.data.number]!;
        if (s.at(-1) !== m.data.state) s.push(m.data.state);
      }
    });

    await live.loadFromAsterisk();
    const snap = live.snapshot(true);
    expect(snap.ami.connected).toBe(true);
    const e101 = snap.extensions.find((e) => e.number === '101')!;
    expect(e101).toMatchObject({ name: 'Alice', state: 'idle', online: true, dnd: false });
    expect(e101.contacts).toEqual([
      expect.objectContaining({
        endpoint: '101',
        status: 'reachable',
        userAgent: expect.stringMatching(/^baresip/),
      }),
    ]);
    expect(snap.extensions.find((e) => e.number === '103')).toMatchObject({
      state: 'unavailable', // no hint: never registered
      online: false,
      dnd: true,
    });

    for (const m of LIVE_EVENTS) events.emit('event', m);
    // 102 is rung by the originate, answers, then 101 rings and answers; both hang up.
    expect(seen['102']).toEqual(expect.arrayContaining(['ringing', 'inuse']));
    expect(seen['101']).toEqual(expect.arrayContaining(['ringing', 'inuse']));
    expect(
      live
        .snapshot(true)
        .extensions.filter((e) => e.number !== '103')
        .map((e) => e.state),
    ).toEqual(['idle', 'idle']);
  });

  it('users see presence but not devices', async () => {
    const live = new LiveState(db, {
      on() {},
      action: async () => ({}),
      actionList: async () => [],
    });
    await live.loadFromDb();
    const u = live.snapshot(false).extensions[0]!;
    expect(u.contacts).toBeUndefined();
    expect(u).toHaveProperty('online');
  });
});

describe.skipIf(!hasTestDb)('/api/live WebSocket', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
  });
  afterAll(() => t?.close());

  const open = async (cookie?: string) => {
    const ws = await t.app.injectWS('/api/live', { headers: cookie ? { cookie } : {} });
    const msgs: LiveMessage[] = [];
    let closed: number | undefined;
    ws.on('message', (d: Buffer) => msgs.push(JSON.parse(String(d))));
    ws.on('close', (code: number) => (closed = code));
    return { ws, msgs, closed: () => closed };
  };
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(fn()).toBe(true);
  };

  it('closes with 4401 without a session', async () => {
    const c = await open();
    await until(() => c.closed() === 4401);
  });

  it('sends a snapshot, then batched deltas; users get no device details', async () => {
    const adminCookie = await t.login(ADMIN.email, ADMIN.password);
    await t.addUser('u@example.com', 'user-password-123');
    const userCookie = await t.login('u@example.com', 'user-password-123');
    const admin = await open(adminCookie);
    const user = await open(userCookie);
    await until(() => admin.msgs.length === 1 && user.msgs.length === 1);
    expect(admin.msgs[0]).toEqual({
      type: 'snapshot',
      data: { extensions: [], trunks: [], ami: { connected: false } },
    });

    // A config change adds an extension: one extension.updated per client, contacts only for admins.
    await t.db.insert(extensions).values({
      number: '150',
      name: 'Live Test',
      sipPasswordEnc: encrypt('x'),
      voicemailPinEnc: encrypt('1234'),
    });
    await t.live.loadFromDb();
    await t.live.loadFromDb(); // no change → no duplicate message
    await until(() => admin.msgs.length === 2 && user.msgs.length === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(admin.msgs).toHaveLength(2);
    expect(admin.msgs[1]).toMatchObject({
      type: 'extension.updated',
      data: { number: '150', contacts: [] },
    });
    expect(user.msgs[1]).toMatchObject({ type: 'extension.updated', data: { number: '150' } });
    expect((user.msgs[1] as { data: object }).data).not.toHaveProperty('contacts');
    admin.ws.terminate();
    user.ws.terminate();
  });
});
