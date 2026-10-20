// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T5: API tokens (04 §2.3) and webhooks (04 §9).
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { eq } from 'drizzle-orm';
import { users, webhookDeliveries } from '../src/db/schema.ts';
import { setSetting } from '../src/services/settings.ts';
import { deliverDue, isPrivateAddress, watchWebhooks } from '../src/services/webhooks.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

it('isPrivateAddress', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:7f00:1',
    '198.18.0.1',
    '192.0.0.8',
    '64:ff9b::a00:1',
    '2002:7f00:1::1',
  ])
    expect(isPrivateAddress(ip), ip).toBe(true);
  for (const ip of ['8.8.8.8', '203.0.113.9', '2001:4860:4860::8888', '::ffff:8.8.8.8'])
    expect(isPrivateAddress(ip), ip).toBe(false);
});

describe.skipIf(!hasTestDb)('API tokens and webhooks', () => {
  /** Waits for n webhook_deliveries rows (a fixed sleep was too short under load). */
  const deliveries = async (n: number) => {
    for (let i = 0; i < 100; i++) {
      if ((await t.db.select().from(webhookDeliveries)).length >= n) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let req: (
    m: string,
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => Promise<LightMyRequestResponse>;
  // The receiving end: answers with `answer`, keeps what it got.
  const got: { headers: IncomingHttpHeaders; body: string }[] = [];
  let answer = 200;
  const server = createServer((r, res) => {
    let body = '';
    r.on('data', (c) => (body += c));
    r.on('end', () => {
      got.push({ headers: r.headers, body });
      res.writeHead(answer).end();
    });
  });
  let url: string;

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    admin = await t.login(ADMIN.email, ADMIN.password);
    req = (method, u, payload, headers = { ...H, cookie: admin }) =>
      t.app.inject({ method: method as 'GET', url: u, payload: payload as object, headers });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(async () => {
    server.close();
    await t.close();
  });

  it('a token is shown once and acts as its admin, without the CSRF header', async () => {
    const r = await req('POST', '/api/api-tokens', { name: 'CRM' });
    expect(r.statusCode).toBe(201);
    const { token, id } = r.json();
    expect(token).toMatch(/^sp_[A-Za-z0-9]{40}$/);
    const list = (await req('GET', '/api/api-tokens')).json().items;
    expect(list).toEqual([
      expect.objectContaining({
        id,
        name: 'CRM',
        tokenPrefix: token.slice(0, 7),
        createdBy: ADMIN.email,
        lastUsedAt: null,
      }),
    ]);
    expect(JSON.stringify(list)).not.toContain(token);

    const bearer = { authorization: `Bearer ${token}` };
    expect((await req('GET', '/api/extensions', undefined, bearer)).statusCode).toBe(200);
    const made = await req('POST', '/api/blocked-numbers', { number: '3125550100' }, bearer);
    expect(made.statusCode).toBe(201);
    expect((await req('GET', '/api/api-tokens')).json().items[0].lastUsedAt).not.toBeNull();
    // A token can't manage tokens.
    expect((await req('POST', '/api/api-tokens', { name: 'more' }, bearer)).statusCode).toBe(403);
    expect((await req('GET', '/api/api-tokens', undefined, bearer)).statusCode).toBe(403);
    // Wrong, malformed or with a cookie that would work: the token decides.
    for (const a of [`Bearer sp_${'x'.repeat(40)}`, 'Bearer nope', `Bearer ${token}x`])
      expect(
        (await req('GET', '/api/extensions', undefined, { authorization: a, cookie: admin }))
          .statusCode,
      ).toBe(401);

    expect((await req('DELETE', `/api/api-tokens/${id}`)).statusCode).toBe(200);
    expect((await req('GET', '/api/extensions', undefined, bearer)).statusCode).toBe(401);
    expect((await req('GET', '/api/api-tokens')).json().items).toEqual([]);
  });

  it("a token stops working when its admin is disabled, and is a user's when demoted", async () => {
    const other = await t.addUser('ops@example.com', 'ops-password-123', 'admin');
    const c = await t.login('ops@example.com', 'ops-password-123');
    const { token } = (
      await req('POST', '/api/api-tokens', { name: 'ops' }, { ...H, cookie: c })
    ).json();
    const bearer = { authorization: `Bearer ${token}` };
    await t.db.update(users).set({ role: 'user' }).where(eq(users.id, other.id));
    expect((await req('GET', '/api/extensions', undefined, bearer)).statusCode).toBe(403);
    await t.db.update(users).set({ isActive: false }).where(eq(users.id, other.id));
    expect((await req('GET', '/api/extensions', undefined, bearer)).statusCode).toBe(401);
    // Users can't make tokens.
    const u = await t.addUser('pat@example.com', 'pat-password-123');
    void u;
    const pc = await t.login('pat@example.com', 'pat-password-123');
    expect(
      (await req('POST', '/api/api-tokens', { name: 'x' }, { ...H, cookie: pc })).statusCode,
    ).toBe(403);
  });

  it('webhooks: validation, private targets refused by default, signed test', async () => {
    expect(
      (await req('POST', '/api/webhooks', { url: 'ftp://x.example/', events: ['call.ended'] }))
        .statusCode,
    ).toBe(400);
    expect((await req('POST', '/api/webhooks', { url, events: [] })).statusCode).toBe(400);
    expect((await req('POST', '/api/webhooks', { url, events: ['nope'] })).statusCode).toBe(400);
    const h = (
      await req('POST', '/api/webhooks', { url, events: ['call.started', 'call.ended'] })
    ).json();
    expect(h.secret).toMatch(/^[0-9a-f]{64}$/);

    let r = (await req('POST', `/api/webhooks/${h.id}/test`)).json();
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('private address') });
    // A name that resolves to loopback is refused at connect time too.
    await req('PATCH', `/api/webhooks/${h.id}`, { url: url.replace('127.0.0.1', 'localhost') });
    r = (await req('POST', `/api/webhooks/${h.id}/test`)).json();
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('private address') });
    expect(got).toEqual([]);

    await req('PATCH', `/api/webhooks/${h.id}`, { url });
    await setSetting(t.db, 'webhooks.allowPrivate', true);
    r = (await req('POST', `/api/webhooks/${h.id}/test`)).json();
    expect(r).toEqual({ ok: true, status: 200 });
    const [m] = got;
    expect(m!.headers['x-selfphoneng-event']).toBe('webhook.test');
    const ts = m!.headers['x-selfphoneng-timestamp'] as string;
    expect(m!.headers['x-selfphoneng-signature']).toBe(
      `sha256=${createHmac('sha256', h.secret).update(`${ts}.${m!.body}`).digest('hex')}`,
    );
    expect(JSON.parse(m!.body)).toMatchObject({
      event: 'webhook.test',
      data: { message: 'Test from SelfPhoneNG' },
    });
  });

  it('live events are queued, delivered and retried 1m, 5m, 30m, 2h, 12h, then failed', async () => {
    got.length = 0;
    watchWebhooks(t.db, t.live, t.app.log);
    const call = {
      linkedid: 'L1',
      startedAt: new Date().toISOString(),
      direction: 'inbound' as const,
      from: { number: '3125550100' },
      to: { number: '201' },
      state: 'ringing' as const,
      extensions: ['201'],
      channels: [],
      recording: false,
    };
    t.live.emit('message', { type: 'call.updated', data: call });
    t.live.emit('message', {
      type: 'call.updated',
      data: { ...call, state: 'talking', answeredAt: call.startedAt },
    });
    t.live.emit('message', { type: 'call.removed', data: { linkedid: 'L1' } });
    await deliveries(2); // the inserts are fire-and-forget
    await deliverDue(t.db);
    // call.answered isn't subscribed.
    expect(got.map((g) => JSON.parse(g.body).event)).toEqual(['call.started', 'call.ended']);
    expect(JSON.parse(got[1]!.body).data).toMatchObject({
      linkedid: 'L1',
      endedAt: expect.any(String),
    });

    answer = 500;
    got.length = 0;
    t.live.emit('message', { type: 'call.updated', data: { ...call, linkedid: 'L2' } });
    await deliveries(3);
    let now = Date.now();
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      await deliverDue(t.db, new Date(now));
      const [d] = await t.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.event, 'call.started'))
        .orderBy(webhookDeliveries.id)
        .offset(1);
      if (d!.nextAttemptAt) {
        gaps.push(Math.round((d!.nextAttemptAt.getTime() - now) / 60_000));
        now = d!.nextAttemptAt.getTime();
      } else expect(d).toMatchObject({ status: 'failed', attempt: 6, responseCode: 500 });
    }
    expect(gaps).toEqual([1, 5, 30, 120, 720]);
    expect(got).toHaveLength(6);
    await deliverDue(t.db, new Date(now + 86_400_000));
    expect(got).toHaveLength(6);
    answer = 200;

    const del = (
      await req(
        'GET',
        `/api/webhooks/${(await req('GET', '/api/webhooks')).json().items[0].id}/deliveries`,
      )
    ).json().items;
    expect(del.map((d: { status: string }) => d.status)).toEqual(['failed', 'done', 'done']);
  });

  it('voicemail.new fires for a mailbox without a user too', async () => {
    await req('POST', '/api/webhooks', { url, events: ['voicemail.new'] });
    await req('POST', '/api/extensions', { number: '205', name: 'Front desk' });
    const inbox = join(t.spoolDir, 'default', '205', 'INBOX');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'msg0000.wav'), '');
    writeFileSync(
      join(inbox, 'msg0000.txt'),
      '[message]\ncallerid="Bo" <3125550111>\norigtime=1792300385\nmsg_id=1792300385-205\nduration=4\n',
    );
    await t.app.voicemail.scan('205');
    await new Promise((r) => setTimeout(r, 200));
    const [d] = await t.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.event, 'voicemail.new'));
    expect(d!.payload).toMatchObject({
      event: 'voicemail.new',
      data: { extension: '205', callerNumber: '3125550111', durationS: 4 },
    });
  });
});
