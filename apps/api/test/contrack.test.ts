// SPDX-License-Identifier: AGPL-3.0-or-later
// C3: contacts in Contrack (11 §4), against a fake Contrack that answers the routes we use.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactNames } from '../src/contacts/book.ts';
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
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/healthz') return send(200, { ok: true });
    const book = books[(req.headers.authorization ?? '').replace(/^Bearer /, '')];
    if (!book) return send(401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
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
  return { server, books };
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

  it('back to builtin: the table again, tokens kept for later', async () => {
    await admin('PATCH', '/api/settings', { 'contacts.provider': 'builtin' });
    const book = (await dan('GET', '/api/me/contacts')).json();
    expect(book).toEqual({ items: [], provider: 'builtin', contrack: null });
    expect((await dan('GET', '/api/me')).json().contrack).toBeNull();
  });
});
