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
import { eq } from 'drizzle-orm';
import { extensions, sessions, userRuntimeState, users } from '../src/db/schema.ts';
import { timing } from '../src/live/hub.ts';
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
      data: {
        extensions: [],
        trunks: [],
        calls: [],
        queues: [],
        parked: [],
        ami: { connected: false },
      },
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

  it('a 911 alert reaches admins and notify users only; trunk status reaches admins only', async () => {
    const admin = await open(await t.login(ADMIN.email, ADMIN.password));
    const notifyUser = await t.addUser('desk@example.com', 'desk-password-123');
    const desk = await open(await t.login('desk@example.com', 'desk-password-123'));
    const other = await open(await t.login('u@example.com', 'user-password-123'));
    await until(() => [admin, desk, other].every((c) => c.msgs.length === 1));
    const call = {
      ext: '101',
      name: 'Dan',
      location: null,
      callerId: '13125551234',
      at: new Date().toISOString(),
      test: false,
      audienceUserIds: [notifyUser.id],
    };
    t.live.emit('message', { type: 'emergency.call', data: call });
    t.live.emit('message', {
      type: 'trunk.updated',
      data: { trunkId: 'x', registration: 'registered', reachable: true, lastChange: call.at },
    });
    await until(() => admin.msgs.length === 3 && desk.msgs.length === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(desk.msgs[1]).toMatchObject({ type: 'emergency.call', data: { ext: '101' } });
    expect(desk.msgs).toHaveLength(2); // no trunk.updated
    expect(other.msgs).toHaveLength(1); // just the snapshot
    for (const c of [admin, desk, other]) c.ws.terminate();
  });

  it("queues reach admins and that queue's agents", async () => {
    const agent = await t.addUser('agent@example.com', 'agent-password-123');
    await t.db.insert(extensions).values({
      number: '160',
      name: 'Agent',
      userId: agent.id,
      sipPasswordEnc: encrypt('x'),
      voicemailPinEnc: encrypt('1234'),
    });
    const admin = await open(await t.login(ADMIN.email, ADMIN.password));
    const me = await open(await t.login('agent@example.com', 'agent-password-123'));
    await until(() => admin.msgs.length === 1 && me.msgs.length === 1);
    const q = (number: string, ext: string) => ({
      type: 'queue.updated' as const,
      data: {
        id: `q-${number}`,
        number,
        name: number,
        waiting: [],
        members: [{ ext, paused: false, state: 'idle' as const, callsTaken: 0 }],
      },
    });
    t.live.emit('message', q('550', '160'));
    t.live.emit('message', q('551', '170'));
    await until(() => admin.msgs.length === 3 && me.msgs.length === 3);
    expect(me.msgs[1]).toMatchObject({ type: 'queue.updated', data: { number: '550' } });
    // not an agent there: it only learns the queue left its view
    expect(me.msgs[2]).toEqual({ type: 'queue.removed', data: { number: '551' } });
    expect(admin.msgs[2]).toMatchObject({ type: 'queue.updated', data: { number: '551' } });
    for (const c of [admin, me]) c.ws.terminate();
  });
});

// M11-T8: a socket from another site is refused; a logout, deactivation or demotion closes it.
describe.skipIf(!hasTestDb)('/api/live WebSocket re-checks', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    timing.recheckMs = 200;
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
  });
  afterAll(() => {
    timing.recheckMs = 30_000;
    return t?.close();
  });

  const open = async (headers: Record<string, string>) => {
    const ws = await t.app.injectWS('/api/live', { headers });
    let closed: number | undefined;
    ws.on('close', (code: number) => (closed = code));
    return () => closed;
  };
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(fn()).toBe(true);
  };

  it('refuses an Origin that is not this host', async () => {
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    const closed = await open({ cookie, origin: 'https://evil.example', host: 'pbx.test' });
    await until(() => closed() === 4403);
    const ok = await open({ cookie, origin: 'https://pbx.test', host: 'pbx.test' });
    await new Promise((r) => setTimeout(r, 500));
    expect(ok()).toBeUndefined();
  });

  it('closes the socket once the session is gone or the role changed', async () => {
    const admin = await t.addUser('demoted@example.com', 'user-password-123', 'admin');
    const closedByRole = await open({
      cookie: await t.login('demoted@example.com', 'user-password-123'),
    });
    const loggedOut = await open({ cookie: await t.login(ADMIN.email, ADMIN.password) });
    await new Promise((r) => setTimeout(r, 500));
    expect(closedByRole()).toBeUndefined();
    await t.db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id));
    const [me] = await t.db.select().from(users).where(eq(users.email, ADMIN.email));
    await t.db.delete(sessions).where(eq(sessions.userId, me!.id));
    await until(() => closedByRole() === 4401 && loggedOut() === 4401);
  });
});
