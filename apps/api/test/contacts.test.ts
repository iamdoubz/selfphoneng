// SPDX-License-Identifier: AGPL-3.0-or-later
// C1: my contacts, the company's, imports and shares (spec 11).
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactNames } from '../src/contacts/book.ts';
import { callerNameToken, phoneSafeName } from '../src/contacts/callername.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

type Req = (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;

describe.skipIf(!hasTestDb)('contacts', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: Req;
  let dan: Req;
  let sue: Req;
  let danId: string;
  const vcf = (name: string, tel: string) =>
    `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nTEL;TYPE=CELL:${tel}\r\nEND:VCARD\r\n`;

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const as =
      (cookie: string): Req =>
      (method, url, payload) =>
        t.app.inject({
          method: method as 'GET',
          url,
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
  afterAll(() => t?.close());

  it('my book and the company book: numbers normalized, users only edit their own', async () => {
    const mine = await dan('POST', '/api/me/contacts', {
      name: 'Jane Doe',
      company: 'Acme',
      email: '',
      numbers: [{ label: 'mobile', number: '(312) 555-1234' }],
    });
    expect(mine.statusCode, mine.body).toBe(201);
    expect(mine.json()).toMatchObject({
      book: 'mine',
      email: null,
      numbers: [{ label: 'mobile', number: '13125551234' }],
    });
    expect(
      (
        await dan('POST', '/api/me/contacts', { name: 'X', numbers: [{ number: 'call me' }] })
      ).json().error.message,
    ).toMatch(/isn't a phone number/);

    const co = await admin('POST', '/api/contacts', {
      name: 'Pizza Place',
      numbers: [{ label: 'main', number: '312-555-0000' }],
    });
    expect(co.statusCode, co.body).toBe(201);
    expect((await dan('GET', '/api/contacts')).statusCode).toBe(403);
    // Dan sees the company contact but can't change it.
    const list = (await dan('GET', '/api/me/contacts')).json().items;
    expect(list.map((c: { name: string; book: string }) => [c.name, c.book])).toEqual([
      ['Jane Doe', 'mine'],
      ['Pizza Place', 'company'],
    ]);
    expect((await dan('DELETE', `/api/me/contacts/${co.json().id}`)).statusCode).toBe(404);
    expect(
      (await sue('PATCH', `/api/me/contacts/${mine.json().id}`, { name: 'Mine now' })).statusCode,
    ).toBe(404);
    expect((await sue('GET', '/api/me/contacts')).json().items).toHaveLength(1); // company only
  });

  it('import: preview first, then save; what is already there is skipped', async () => {
    const files = [
      {
        name: 'phone.vcf',
        text:
          vcf('Jane Doe', '+1 312 555 1234') + // already in Dan's book
          vcf('Bob Smith', '312.555.9999') +
          'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Nobody Home\r\nEMAIL:n@example.com\r\nEND:VCARD\r\n',
      },
      { name: 'more.csv', text: 'name,number1\nBob Smith,3125559999\nCarl,12ab\n' },
    ];
    const preview = await dan('POST', '/api/me/contacts/import', { files });
    expect(preview.json()).toEqual({
      committed: false,
      added: 3,
      duplicates: 2,
      noNumber: 2,
      errors: ['Carl: "12ab" isn\'t a phone number, left out'],
    });
    expect((await dan('GET', '/api/me/contacts')).json().items).toHaveLength(2);
    const saved = await dan('POST', '/api/me/contacts/import?commit=1', { files });
    expect(saved.json()).toMatchObject({ committed: true, added: 3, duplicates: 2 });
    expect((await dan('POST', '/api/me/contacts/import?commit=1', { files })).json()).toMatchObject(
      {
        added: 0,
        duplicates: 5,
      },
    );
    // An admin imports into the company book.
    const co = await admin('POST', '/api/contacts/import?commit=1', {
      files: [{ name: 'co.vcf', text: vcf('Plumber', '3125557777') }],
    });
    expect(co.json()).toMatchObject({ added: 1 });
    expect(
      (await sue('GET', '/api/me/contacts')).json().items.map((c: { name: string }) => c.name),
    ).toEqual(['Pizza Place', 'Plumber']);
  });

  it('sharing offers a copy; nothing lands until Accept, Deny adds nothing', async () => {
    const book = (await dan('GET', '/api/me/contacts')).json().items as {
      id: string;
      name: string;
      book: string;
    }[];
    const jane = book.find((c) => c.name === 'Jane Doe')!;
    const bob = book.find((c) => c.name === 'Bob Smith')!;
    expect(
      (
        await dan('POST', '/api/me/contacts/share', {
          contactIds: [book.find((c) => c.book === 'company')!.id],
          everyone: true,
        })
      ).statusCode,
    ).toBe(404); // not Dan's to share
    const r = await dan('POST', '/api/me/contacts/share', {
      contactIds: [jane.id, bob.id],
      extensions: ['102'],
    });
    expect(r.json()).toEqual({ offers: 2, people: 1 });
    // Shared again: still one offer per contact.
    await dan('POST', '/api/me/contacts/share', { contactIds: [jane.id, bob.id], everyone: true });

    const before = (await sue('GET', '/api/me/contacts')).json().items.length;
    const offers = (await sue('GET', '/api/me/contacts/shares')).json().items as {
      id: string;
      from: { name: string };
      contact: { name: string };
    }[];
    expect(offers.map((o) => [o.from.name, o.contact.name]).sort()).toEqual([
      ['dan@example.com', 'Bob Smith'],
      ['dan@example.com', 'Jane Doe'],
    ]);
    expect((await sue('GET', '/api/me/contacts')).json().items).toHaveLength(before);

    const janeOffer = offers.find((o) => o.contact.name === 'Jane Doe')!;
    const bobOffer = offers.find((o) => o.contact.name === 'Bob Smith')!;
    expect(
      (await sue('POST', '/api/me/contacts/shares/deny', { ids: [bobOffer.id] })).json(),
    ).toEqual({ denied: 1 });
    expect(
      (await sue('POST', '/api/me/contacts/shares/accept', { ids: [janeOffer.id] })).json(),
    ).toEqual({
      added: 1,
      duplicates: 0,
    });
    // Decided offers can't be decided again, or by someone else.
    expect(
      (await sue('POST', '/api/me/contacts/shares/accept', { ids: [bobOffer.id] })).json(),
    ).toEqual({
      added: 0,
      duplicates: 0,
    });
    const names = (await sue('GET', '/api/me/contacts'))
      .json()
      .items.map((c: { name: string }) => c.name);
    expect(names).toContain('Jane Doe');
    expect(names).not.toContain('Bob Smith');
    expect((await sue('GET', '/api/me/contacts/shares')).json().items).toEqual([]);
    // The copy is Sue's own: Dan editing his doesn't change it.
    await dan('PATCH', `/api/me/contacts/${jane.id}`, { name: 'Jane D.', numbers: [] });
    expect(
      (await sue('GET', '/api/me/contacts')).json().items.map((c: { name: string }) => c.name),
    ).toContain('Jane Doe');
  });

  it('looks up names: my book first, then the company', async () => {
    await admin('POST', '/api/contacts', {
      name: 'Front desk',
      numbers: [{ number: '3125551234' }],
    });
    await dan('POST', '/api/me/contacts', { name: 'My Jane', numbers: [{ number: '3125551234' }] });
    const names = await contactNames(t.db, danId, [
      '13125551234',
      '13125550000',
      '19995550000',
      null,
    ]);
    expect(Object.fromEntries(names)).toEqual({
      '13125551234': 'My Jane',
      '13125550000': 'Pizza Place',
    });
    const company = await contactNames(t.db, null, ['13125551234']);
    expect(company.get('13125551234')).toBe('Front desk');
  });

  it('the dialplan lookup (C4): only with the key, never through the proxy, phone-safe names', async () => {
    const token = callerNameToken(t.app.config.APP_SECRET);
    const look = (q: string, headers: Record<string, string> = {}) =>
      t.app.inject({ method: 'GET', url: `/api/internal/caller-name?${q}`, headers });
    const mine = await look(`ext=101&number=13125551234&token=${token}`);
    expect([mine.statusCode, mine.body]).toEqual([200, 'My Jane']);
    expect((await look(`ext=102&number=13125551234&token=${token}`)).body).toBe('Jane Doe'); // Sue's own copy, from the accepted share
    expect((await look(`ext=999&number=13125551234&token=${token}`)).body).toBe('Front desk'); // no user
    expect((await look(`ext=101&number=19995550000&token=${token}`)).body).toBe('');
    expect((await look('ext=101&number=13125551234&token=wrong')).statusCode).toBe(404);
    expect(
      (
        await look(`ext=101&number=13125551234&token=${token}`, {
          'x-forwarded-for': '203.0.113.9',
        })
      ).statusCode,
    ).toBe(404);
    expect(phoneSafeName(String.raw`Jane "J" <Doe>, Inc.; (x)^|\ Ünïcode-Smith`)).toBe(
      'Jane J Doe Inc. x Ünïcode-Smith',
    );
    expect(phoneSafeName('A'.repeat(60))).toHaveLength(40);
  });
});
