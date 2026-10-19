// SPDX-License-Identifier: AGPL-3.0-or-later
// M8-T1: /api/queues (03 §6.8, 04 §7.3), agent pause from the UI and *45, stats from events.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { queueCalls, queueMemberState } from '../src/db/schema.ts';
import { syncAstDb } from '../src/services/astdb.ts';
import { recordQueueEvent } from '../src/services/queuestats.ts';
import { handleToggle } from '../src/services/toggles.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('/api/queues', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let dan: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  const ext: Record<string, string> = {};
  let queueId: string;
  const conf = async (f: string) => {
    await t.app.generator.apply({ trigger: 'test' });
    return readFile(join(t.genDir, f), 'utf8');
  };
  const state = async () =>
    (await t.db.select().from(queueMemberState)).map((s) => ({
      ext: Object.keys(ext).find((n) => ext[n] === s.extensionId),
      paused: s.paused,
    }));

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
    const danUser = await t.addUser('dan@example.com', 'dan-password-123');
    dan = as(await t.login('dan@example.com', 'dan-password-123'));
    for (const [n, name] of [
      ['101', 'Dan Doe'],
      ['102', 'Sue Smith'],
      ['103', 'Ann Lee'],
    ] as const)
      ext[n] = (
        await admin('POST', '/api/extensions', {
          number: n,
          name,
          ...(n === '101' ? { userId: danUser.id } : {}),
        })
      ).json().id;
  });
  afterAll(() => t?.close());

  it('creates a queue with agents; config and dialplan follow', async () => {
    const r = await admin('POST', '/api/queues', {
      number: '550',
      name: 'Support',
      members: [
        { extensionId: ext['102'], penalty: 1 },
        { extensionId: ext['101'], penalty: 0 },
      ],
      timeoutDestination: { type: 'voicemail', id: ext['101'] },
    });
    expect(r.statusCode, r.body).toBe(201);
    queueId = r.json().id;
    expect(r.json()).toMatchObject({
      strategy: 'rrmemory',
      maxWaitSeconds: 300,
      timeoutSummary: 'Voicemail of Dan Doe (101)',
      members: [
        { extensionId: ext['101'], penalty: 0, paused: false },
        { extensionId: ext['102'], penalty: 1, paused: false },
      ],
    });
    const q = await conf('queues_selfphoneng.conf');
    expect(q).toContain('[550]');
    expect(q).toContain(
      'member => Local/101@sp-queue-member/n,0,Dan Doe,hint:101@sp-local-numbers',
    );
    expect(q).toContain(
      'member => Local/102@sp-queue-member/n,1,Sue Smith,hint:102@sp-local-numbers',
    );
    const d = await conf('extensions_selfphoneng.conf');
    expect(d).toContain(`exten => 550,1,Goto(sp-queue-${queueId},s,1)`);
    expect(d).toContain(' same => n,Queue(550,t,,,300)');
    expect(t.ami.commands).toContain('queue reload all');
  });

  it('checks the number, agents and destination', async () => {
    const bad = (body: object) =>
      admin('POST', '/api/queues', {
        number: '551',
        name: 'X',
        timeoutDestination: { type: 'hangup' },
        ...body,
      });
    expect((await bad({ number: '500' })).statusCode).toBe(400); // outside 550–599
    expect((await bad({ number: '550' })).statusCode).toBe(409);
    const twice = { extensionId: ext['101'], penalty: 0 };
    expect((await bad({ members: [twice, twice] })).statusCode).toBe(400);
    expect(
      (
        await bad({
          members: [{ extensionId: '00000000-0000-4000-8000-000000000999', penalty: 0 }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await bad({
          timeoutDestination: { type: 'queue', id: '00000000-0000-4000-8000-000000000999' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await admin('PATCH', `/api/queues/${queueId}`, {
          timeoutDestination: { type: 'queue', id: queueId },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('admin pause: PostgreSQL, AstDB and app_queue; unpause undoes it', async () => {
    t.ami.actions.length = 0;
    const r = await admin('POST', `/api/queues/${queueId}/members/${ext['102']}/pause`);
    expect(r.statusCode, r.body).toBe(200);
    expect(await state()).toEqual([{ ext: '102', paused: true }]);
    expect(t.ami.actions).toEqual([
      { Action: 'DBPut', Family: 'SP', Key: 'QPAUSE/550/102', Val: '1' },
      {
        Action: 'QueuePause',
        Queue: '550',
        Interface: 'Local/102@sp-queue-member/n',
        Paused: 'true',
      },
    ]);
    expect((await admin('GET', `/api/queues/${queueId}`)).json().members[1].paused).toBe(true);
    // not an agent of the queue
    expect(
      (await admin('POST', `/api/queues/${queueId}/members/${ext['103']}/pause`)).statusCode,
    ).toBe(404);

    t.ami.actions.length = 0;
    await admin('POST', `/api/queues/${queueId}/members/${ext['102']}/unpause`);
    expect(await state()).toEqual([{ ext: '102', paused: false }]);
    expect(t.ami.actions.map((a) => a.Action)).toEqual(['DBDel', 'QueuePause']);
  });

  it('agents log themselves in and out from Home, only for their own queues', async () => {
    expect((await dan('POST', `/api/me/queues/${queueId}/pause`)).statusCode).toBe(200);
    expect(await state()).toContainEqual({ ext: '101', paused: true });
    expect(
      (await dan('POST', `/api/queues/${queueId}/members/${ext['101']}/unpause`)).statusCode,
    ).toBe(403);
    const other = await admin('POST', '/api/queues', {
      number: '551',
      name: 'Billing',
      members: [{ extensionId: ext['103'], penalty: 0 }],
      timeoutDestination: { type: 'hangup' },
    });
    expect((await dan('POST', `/api/me/queues/${other.json().id}/pause`)).statusCode).toBe(404);
    expect((await dan('POST', `/api/me/queues/${queueId}/unpause`)).statusCode).toBe(200);
    await admin('DELETE', `/api/queues/${other.json().id}`);
  });

  it('*45 from a phone (SpToggle QPAUSE) updates PostgreSQL', async () => {
    const toggle = (Value: string) =>
      handleToggle(
        { db: t.db, ami: t.ami, live: t.live, log: t.app.log },
        {
          Event: 'UserEvent',
          UserEvent: 'SpToggle',
          Key: 'QPAUSE',
          Queue: '550',
          Ext: '102',
          Value,
        },
      );
    await toggle('1');
    expect(await state()).toContainEqual({ ext: '102', paused: true });
    await toggle('0');
    expect(await state()).toContainEqual({ ext: '102', paused: false });
  });

  it('a queue reload and an AstDB resync pause the paused agents again', async () => {
    await admin('POST', `/api/queues/${queueId}/members/${ext['102']}/pause`);
    t.ami.actions.length = 0;
    await t.app.generator.apply({ trigger: 'test', force: true });
    expect(t.ami.actions).toContainEqual({
      Action: 'QueuePause',
      Queue: '550',
      Interface: 'Local/102@sp-queue-member/n',
      Paused: 'true',
    });
    t.ami.actions.length = 0;
    await syncAstDb(t.db, t.ami);
    expect(t.ami.actions).toContainEqual({
      Action: 'DBPut',
      Family: 'SP',
      Key: 'QPAUSE/550/102',
      Val: '1',
    });
  });

  it('removing an agent forgets their pause', async () => {
    const r = await admin('PATCH', `/api/queues/${queueId}`, {
      members: [{ extensionId: ext['101'], penalty: 0 }],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await state()).map((s) => s.ext)).not.toContain('102');
    expect(await conf('queues_selfphoneng.conf')).not.toContain('Local/102@');
  });

  it('stats from app_queue events (shapes as on a real Asterisk 24)', async () => {
    const ev = (Event: string, Uniqueid: string, extra: Record<string, string> = {}) =>
      recordQueueEvent(t.db, { Event, Queue: '550', Uniqueid, Linkedid: Uniqueid, ...extra });
    const exit = (Uniqueid: string, Status: string) =>
      ev('UserEvent', Uniqueid, { UserEvent: 'SpQueueExit', Status });
    await ev('QueueCallerJoin', '1.1');
    await ev('AgentConnect', '1.1', { HoldTime: '3', Interface: 'Local/101@sp-queue-member/n' });
    await ev('QueueCallerJoin', '1.2');
    await ev('AgentConnect', '1.2', { HoldTime: '45', Interface: 'Local/101@sp-queue-member/n' });
    await ev('QueueCallerJoin', '1.3');
    await ev('QueueCallerAbandon', '1.3', { HoldTime: '4' }); // hung up
    await ev('QueueCallerJoin', '1.4');
    await ev('QueueCallerAbandon', '1.4', { HoldTime: '300' }); // a timeout looks the same…
    await exit('1.4', 'TIMEOUT'); // …until the dialplan says so
    await exit('1.5', 'JOINEMPTY'); // turned away without joining
    await ev('QueueCallerJoin', '1.6'); // still waiting
    await ev('QueueCallerJoin', '1.7', { Queue: '999' }); // not ours
    expect((await admin('GET', `/api/queues/${queueId}/stats`)).json()).toEqual({
      offered: 6,
      answered: 2,
      abandoned: 1,
      timedOut: 2,
      avgWaitSeconds: 24,
      // sla 20 s: 3 s yes; 45 s, the timeout and the turned away no; the 4 s hang-up and the
      // caller still waiting don't count
      withinSlaPercent: 25,
    });
    const [taken] = await t.db.select().from(queueCalls).where(eq(queueCalls.uniqueid, '1.1'));
    expect(taken).toMatchObject({
      outcome: 'answered',
      waitSeconds: 3,
      agentExtensionId: ext['101'],
    });
    expect(
      (await admin('GET', `/api/queues/${queueId}/stats?from=2026-01-01&to=2026-01-02`)).json(),
    ).toMatchObject({ offered: 0, avgWaitSeconds: null, withinSlaPercent: null });
  });

  it('a phone number can point at it; delete is refused while it does', async () => {
    const trunkId = (
      await admin('POST', '/api/trunks', {
        name: 'voip.ms',
        serverHost: '127.0.0.1',
        username: '123456_pbx',
        password: 'pw',
      })
    ).json().id;
    const did = await admin('POST', '/api/dids', {
      number: '3125551234',
      trunkId,
      destination: { type: 'queue', id: queueId },
    });
    expect(did.json().destinationSummary).toBe('Queue Support (550)');
    expect(await conf('extensions_selfphoneng.conf')).toContain(`Goto(sp-queue-${queueId},s,1)`);
    expect((await admin('DELETE', `/api/queues/${queueId}`)).statusCode).toBe(409);
    await admin('PATCH', `/api/dids/${did.json().id}`, { destination: { type: 'hangup' } });
    expect((await admin('DELETE', `/api/queues/${queueId}`)).statusCode).toBe(200);
    expect(await conf('queues_selfphoneng.conf')).not.toContain('[550]');
  });
});
