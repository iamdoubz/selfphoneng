// SPDX-License-Identifier: AGPL-3.0-or-later
// C3: contacts in Contrack (11 §4), against a fake Contrack that answers the routes we use.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { contactNames } from '../src/contacts/book.ts';
import { forgetBook } from '../src/contacts/contrack.ts';
import { logCallsToContrack } from '../src/contacts/timeline.ts';
import {
  callExtensions,
  calls,
  contacts,
  contrackCallLog,
  extensions,
  recordings,
  users,
} from '../src/db/schema.ts';
import { setSetting } from '../src/services/settings.ts';
import { loadPhonebook } from '../src/provisioning/context.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

type Req = (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
type Slim = {
  id: string;
  name: string;
  company: string | null;
  emails: { email: string }[];
  phones: { phone: string }[];
};

/** Contrack's slim rows, one private book per token (11 §4.1). */
function fakeContrack() {
  const books: Record<string, Slim[]> = {
    ctk_company: [
      {
        id: 'plumber-1a2b3c4d',
        name: 'Plumber',
        company: null,
        emails: [],
        phones: [{ phone: '+1 312 555 7777' }],
      },
    ],
    ctk_dan_0001: [
      {
        id: 'jane-doe-00000001',
        name: 'Jane Doe',
        company: 'Acme',
        emails: [{ email: 'jane@acme.example' }],
        phones: [{ phone: '(312) 555-1234' }, { phone: 'ask reception' }],
      },
    ],
    ctk_sue_0001: [],
  };
  let n = 0;
  /** Timeline entries by contact id; `down` makes every API call fail with 503. */
  const timeline: Record<string, Record<string, unknown>[]> = {};
  const state = { down: false, readOnly: new Set<string>() };
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/healthz') return send(200, { ok: true });
    if (state.down) return send(503, { error: { code: 'DB_BUSY', message: 'Busy' } });
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const book = books[token];
    if (!book) return send(401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    if (req.method === 'POST' && req.url === '/api/contacts/bulk') {
      if (!/^[0-9a-f-]{36}$/.test(String(req.headers['x-import-id'])))
        return send(400, { error: { code: 'VALIDATION_ERROR', message: 'X-Import-Id' } });
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const rows = JSON.parse(raw) as { name: string; phones: { phone: string }[] }[];
        for (const r of rows)
          book.push({
            id: `bulk-${++n}`,
            name: r.name,
            company: null,
            emails: [],
            phones: r.phones,
          });
        send(201, {
          success: true,
          count: rows.length,
          failed: 0,
          importId: req.headers['x-import-id'],
        });
      });
      return;
    }
    const into = /^\/api\/contacts\/([^/]+)\/interactions$/.exec(req.url ?? '');
    if (req.method === 'POST' && into) {
      if (state.readOnly.has(token))
        return send(403, { error: { code: 'TOKEN_READ_ONLY', message: 'Read-only token' } });
      if (!book.some((c) => c.id === into[1]))
        return send(404, { error: { code: 'NOT_FOUND', message: 'Contact not found' } });
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const id = `int-${++n}`;
        (timeline[into[1]!] ??= []).push({ id, ...(JSON.parse(raw) as object) });
        send(201, { id });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/contacts?view=slim') return send(200, book);
    if (req.method === 'POST' && req.url === '/api/contacts') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const b = JSON.parse(raw) as {
          name: string;
          company?: string;
          emails?: { email: string }[];
          phones: { phone: string }[];
        };
        const row = {
          id: `new-${++n}`,
          name: b.name,
          company: b.company ?? null,
          emails: b.emails ?? [],
          phones: b.phones,
        };
        book.push(row);
        send(201, row);
      });
      return;
    }
    send(404, { error: { code: 'ROUTE_NOT_FOUND', message: 'No route' } });
  });
  return { server, books, timeline, state };
}

describe.skipIf(!hasTestDb)('contacts in Contrack', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: Req;
  let dan: Req;
  let sue: Req;
  let danId: string;
  const fake = fakeContrack();
  let url: string;

  beforeAll(async () => {
    await new Promise<void>((ok) => fake.server.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const as =
      (cookie: string): Req =>
      (method, u, payload) =>
        t.app.inject({
          method: method as 'GET',
          url: u,
          payload: payload as object,
          headers: { ...H, cookie },
        });
    admin = as(await t.login(ADMIN.email, ADMIN.password));
    danId = (await t.addUser('dan@example.com', 'dan-password-123')).id;
    const sueId = (await t.addUser('sue@example.com', 'sue-password-123')).id;
    await admin('POST', '/api/extensions', { number: '101', name: 'Dan Doe', userId: danId });
    await admin('POST', '/api/extensions', { number: '102', name: 'Sue Smith', userId: sueId });
    dan = as(await t.login('dan@example.com', 'dan-password-123'));
    sue = as(await t.login('sue@example.com', 'sue-password-123'));
  });
  afterAll(async () => {
    await t?.close();
    fake.server.close();
  });

  it('Settings → Contacts: a local address only, the company token write-only', async () => {
    const far = await admin('PATCH', '/api/settings', {
      'contacts.contrack': { url: 'https://contrack.example.com', companyToken: 'ctk_company' },
    });
    expect(far.statusCode).toBe(400);
    expect(far.json().error.message).toMatch(/IP address/);
    expect(
      (
        await admin('POST', '/api/contacts/contrack/test', { url, companyToken: 'ctk_company' })
      ).json(),
    ).toEqual({
      ok: true,
      detail: 'Contrack answers; the token reads 1 contact.',
    });
    expect(
      (
        await admin('POST', '/api/contacts/contrack/test', {
          url: 'http://127.0.0.1:9',
          companyToken: 'x',
        })
      ).json().ok,
    ).toBe(false);
    const r = await admin('PATCH', '/api/settings', {
      'contacts.provider': 'contrack',
      'contacts.contrack': {
        url: `${url}/`,
        publicUrl: 'https://contacts.example.com/',
        companyToken: 'ctk_company',
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()['contacts.contrack']).toEqual({
      url,
      publicUrl: 'https://contacts.example.com',
      hasCompanyToken: true,
    });
    expect(r.body).not.toContain('ctk_company');
    // Saving again without a token keeps it.
    await admin('PATCH', '/api/settings', {
      'contacts.contrack': { url, publicUrl: 'https://contacts.example.com' },
    });
    expect((await admin('GET', '/api/settings')).json()['contacts.contrack'].hasCompanyToken).toBe(
      true,
    );
  });

  it('each person connects their own token; until then they see the company book', async () => {
    expect((await dan('GET', '/api/me')).json().contrack).toEqual({
      connected: false,
      tokenPrefix: null,
      publicUrl: 'https://contacts.example.com',
      logCalls: true,
      logSummaries: false,
      summariesAvailable: false,
    });
    const before = (await dan('GET', '/api/me/contacts')).json();
    expect(before.provider).toBe('contrack');
    expect(before.contrack.connected).toBe(false);
    expect(before.items.map((c: { name: string }) => c.name)).toEqual(['Plumber']);

    const bad = await dan('PUT', '/api/me/contrack', { token: 'ctk_not_mine' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/refused the token/);
    const ok = await dan('PUT', '/api/me/contrack', { token: 'ctk_dan_0001' });
    expect(ok.json().contrack).toMatchObject({ connected: true, tokenPrefix: 'ctk_dan_0001…' });

    const book = (await dan('GET', '/api/me/contacts')).json();
    expect(book.contrack).toEqual({
      publicUrl: 'https://contacts.example.com',
      connected: true,
      error: null,
      toCopy: 0,
    });
    expect(book.items).toEqual([
      {
        id: 'jane-doe-00000001',
        book: 'mine',
        name: 'Jane Doe',
        company: 'Acme',
        email: 'jane@acme.example',
        numbers: [{ label: '', number: '13125551234' }], // "ask reception" isn't a number
        notes: null,
        url: 'https://contacts.example.com/contact/jane-doe-00000001',
      },
      expect.objectContaining({ name: 'Plumber', book: 'company' }),
    ]);
  });

  it('adding works, editing and importing happen in Contrack', async () => {
    const r = await dan('POST', '/api/me/contacts', {
      name: 'Bob',
      numbers: [{ label: 'mobile', number: '312-555-9999' }],
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(fake.books.ctk_dan_0001!.at(-1)).toMatchObject({
      name: 'Bob',
      phones: [{ phone: '13125559999', label: 'mobile' }],
    });
    expect(
      (await dan('GET', '/api/me/contacts')).json().items.map((c: { name: string }) => c.name),
    ).toContain('Bob');
    expect(
      (
        await dan('PATCH', `/api/me/contacts/${'00000000-0000-4000-8000-000000000000'}`, {
          name: 'x',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await dan('POST', '/api/me/contacts/import', {
          files: [{ name: 'a.vcf', text: 'BEGIN:VCARD\nFN:A\nEND:VCARD' }],
        })
      ).statusCode,
    ).toBe(409);
  });

  it('names come from my Contrack book, then the company account; desk phones get the company', async () => {
    const names = await contactNames(t.db, danId, ['13125551234', '13125557777']);
    expect(Object.fromEntries(names)).toEqual({
      '13125551234': 'Jane Doe',
      '13125557777': 'Plumber',
    });
    expect((await loadPhonebook(t.db)).map((e) => e.name)).toEqual([
      'Dan Doe',
      'Sue Smith',
      'Plumber',
    ]);
  });

  it('a share waits until the recipient has connected Contrack, then lands in their account', async () => {
    const r = await dan('POST', '/api/me/contacts/share', {
      contactIds: ['jane-doe-00000001'],
      extensions: ['102'],
    });
    expect(r.json()).toEqual({ offers: 1, people: 1 });
    const [offer] = (await sue('GET', '/api/me/contacts/shares')).json().items;
    expect(offer.contact).toMatchObject({
      name: 'Jane Doe',
      numbers: [{ label: '', number: '13125551234' }],
    });

    const early = await sue('POST', '/api/me/contacts/shares/accept', { ids: [offer.id] });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.message).toMatch(/Connect your Contrack account/);
    expect((await sue('GET', '/api/me/contacts/shares')).json().items).toHaveLength(1);

    await sue('PUT', '/api/me/contrack', { token: 'ctk_sue_0001' });
    expect(
      (await sue('POST', '/api/me/contacts/shares/accept', { ids: [offer.id] })).json(),
    ).toEqual({ added: 1, duplicates: 0 });
    expect(fake.books.ctk_sue_0001!.map((c) => c.name)).toEqual(['Jane Doe']);
    expect((await sue('GET', '/api/me/contacts/shares')).json().items).toEqual([]);
  });

  it("calls go on the contact's timeline once, the summary when asked for (C5)", async () => {
    const now = Date.now();
    const at = (minAgo: number) => new Date(now - minAgo * 60_000);
    // Dan connected a moment ago: his calls from an hour back count for this test.
    await t.db
      .update(users)
      .set({ contrackLogSince: at(60) })
      .where(eq(users.id, danId));
    await setSetting(t.db, 'ai.callTranscripts', true);
    await setSetting(t.db, 'ai.callSummaries', true);
    const [ext] = await t.db.select().from(extensions).where(eq(extensions.number, '101'));
    const [done, pending] = await t.db
      .insert(recordings)
      .values([
        {
          linkedid: 'r1',
          filePath: 'r1.wav',
          startedAt: at(30),
          summary: 'Acme wants a quote.\nAction items:\n- Dan sends the quote',
          aiDoneAt: at(25),
        },
        { linkedid: 'r2', filePath: 'r2.wav', startedAt: at(10) },
      ])
      .returning();
    const call = (linkedid: string, minAgo: number, v: Partial<typeof calls.$inferInsert>) => ({
      linkedid,
      direction: 'inbound' as const,
      status: 'answered' as const,
      startedAt: at(minAgo + 3),
      endedAt: at(minAgo),
      fromNumber: '13125551234', // Jane Doe
      toNumber: '13125550000',
      talkSeconds: 125,
      ...v,
    });
    const rows = await t.db
      .insert(calls)
      .values([
        call('k1', 30, { recordingId: done!.id }), // answered, recorded, summarized
        call('k2', 20, { status: 'missed', talkSeconds: 0 }),
        call('k3', 15, { direction: 'outbound', fromNumber: '101', toNumber: '13125551234' }),
        call('k4', 12, { fromNumber: '13125550101' }), // not a contact
        call('k5', 10, { recordingId: pending!.id }), // not summarized yet
        call('k6', 90, {}), // before Dan connected
        call('k7', 0.2, {}), // still being written (under a minute ago)
      ])
      .returning();
    const role = (i: number) => (rows[i]!.direction === 'outbound' ? 'caller' : 'answered');
    await t.db
      .insert(callExtensions)
      .values(rows.map((r, i) => ({ callId: r.id, extensionId: ext!.id, role: role(i) })));
    const run = (min = 0) =>
      logCallsToContrack({ db: t.db, log: t.app.log, now: new Date(now + min * 60_000) });

    // Summaries off (the default): no summary, and nothing waits for one.
    expect(await run()).toBe(4); // k1, k2, k3, k5 (k4 a stranger, k6 too early, k7 too fresh)
    const jane = fake.timeline['jane-doe-00000001']!;
    expect(jane.map((e) => e.title)).toEqual([
      'Incoming call',
      'Missed call',
      'Outgoing call',
      'Incoming call',
    ]);
    expect(jane[0]).toMatchObject({
      type: 'call',
      source: 'selfphoneng',
      date: rows[0]!.startedAt.toISOString(),
      duration: 3,
      content: '<p>From (312) 555-1234 to (312) 555-0000 · 2:05 · recorded</p>',
    });
    expect(jane[0]).not.toHaveProperty('actionItem');
    expect(await run()).toBe(0); // once

    // With summaries: the next recorded call waits for its summary, then carries it.
    await dan('PATCH', '/api/me/contrack', { logSummaries: true });
    const [k8] = await t.db
      .insert(calls)
      .values(call('k8', 5, { recordingId: done!.id }))
      .returning();
    const [k9] = await t.db
      .insert(calls)
      .values(call('k9', 4, { recordingId: pending!.id }))
      .returning();
    await t.db
      .insert(callExtensions)
      .values([k8!, k9!].map((r) => ({ callId: r.id, extensionId: ext!.id, role: 'answered' })));
    expect(await run()).toBe(1); // k8; k9 waits
    expect(jane.at(-1)).toMatchObject({
      content:
        '<p>From (312) 555-1234 to (312) 555-0000 · 2:05 · recorded</p><p>Acme wants a quote.</p><p>Action items:</p><ul><li>Dan sends the quote</li></ul>',
      actionItem: {
        title: 'Dan sends the quote',
        dueAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    });
    // 40 minutes on: k9 without a summary (it waited 30), and k7 is old enough now.
    expect(await run(40)).toBe(2);
    expect(jane.find((e) => e.date === k9!.startedAt.toISOString())!.content).toBe(
      '<p>From (312) 555-1234 to (312) 555-0000 · 2:05 · recorded</p>',
    );
    expect(jane).toHaveLength(7);

    // Contrack down: nothing is lost, the call goes in on a later run.
    const [k10] = await t.db
      .insert(calls)
      .values(call('k10', 3, {}))
      .returning();
    await t.db
      .insert(callExtensions)
      .values({ callId: k10!.id, extensionId: ext!.id, role: 'answered' });
    forgetBook(danId);
    fake.state.down = true;
    expect(await run()).toBe(0);
    fake.state.down = false;
    forgetBook(danId);
    expect(await run()).toBe(1);
    // A read-only token: noted once, not retried every minute.
    fake.state.readOnly.add('ctk_dan_0001');
    const [k11] = await t.db
      .insert(calls)
      .values(call('k11', 2, {}))
      .returning();
    await t.db
      .insert(callExtensions)
      .values({ callId: k11!.id, extensionId: ext!.id, role: 'answered' });
    expect(await run()).toBe(0);
    const [noted] = await t.db
      .select()
      .from(contrackCallLog)
      .where(eq(contrackCallLog.callId, k11!.id));
    expect(noted).toMatchObject({ interactionId: null, error: 'Contrack: Read-only token' });
    fake.state.readOnly.clear();
    expect(await run()).toBe(0);
    expect(jane).toHaveLength(8);
  });

  it('contacts from before Contrack are copied once, the builtin ones kept (C6)', async () => {
    await t.db.insert(contacts).values([
      {
        name: 'Jane Doe',
        ownerUserId: danId,
        numbers: [{ label: 'mobile', number: '13125551234' }],
      }, // in Contrack
      {
        name: 'Old Friend',
        ownerUserId: danId,
        numbers: [{ label: 'home', number: '13125550202' }],
      },
      { name: 'Plumber', numbers: [{ label: '', number: '13125557777' }] }, // in the company account
      { name: 'Locksmith', numbers: [{ label: 'work', number: '13125550303' }] },
    ]);
    expect((await dan('GET', '/api/me/contacts')).json().contrack.toCopy).toBe(1);
    expect((await dan('POST', '/api/me/contacts/copy-to-contrack')).json()).toEqual({
      added: 1,
      duplicates: 1,
      failed: 0,
    });
    expect(fake.books.ctk_dan_0001!.at(-1)).toMatchObject({
      name: 'Old Friend',
      phones: [{ phone: '13125550202', label: 'home' }],
    });
    expect((await dan('GET', '/api/me/contacts')).json().contrack.toCopy).toBe(0);
    expect((await dan('POST', '/api/me/contacts/copy-to-contrack')).json()).toEqual({
      added: 0,
      duplicates: 2,
      failed: 0,
    });
    // The company book, by an admin only.
    expect((await dan('POST', '/api/contacts/copy-to-contrack')).statusCode).toBe(403);
    expect((await admin('GET', '/api/contacts')).json().contrack.toCopy).toBe(1);
    expect((await admin('POST', '/api/contacts/copy-to-contrack')).json()).toEqual({
      added: 1,
      duplicates: 1,
      failed: 0,
    });
    expect(fake.books.ctk_company!.map((c) => c.name)).toEqual(['Plumber', 'Locksmith']);
    // Dan's desk phone: his Contrack contacts, then the company's.
    const names = (await loadPhonebook(t.db, danId)).map((e) => e.name);
    expect(names.indexOf('Old Friend')).toBeGreaterThan(-1);
    expect(names.indexOf('Old Friend')).toBeLessThan(names.indexOf('Locksmith'));
    expect((await loadPhonebook(t.db, null)).map((e) => e.name)).not.toContain('Old Friend');
  });

  it('back to builtin: the table again, tokens kept for later', async () => {
    await admin('PATCH', '/api/settings', { 'contacts.provider': 'builtin' });
    const book = (await dan('GET', '/api/me/contacts')).json();
    expect([book.provider, book.contrack]).toEqual(['builtin', null]);
    expect(book.items.map((c: { name: string }) => c.name)).toEqual([
      'Jane Doe',
      'Old Friend',
      'Locksmith',
      'Plumber',
    ]);
    expect((await dan('GET', '/api/me')).json().contrack).toBeNull();
  });
});
