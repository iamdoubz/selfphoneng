// SPDX-License-Identifier: AGPL-3.0-or-later
// C3 against a real Contrack (decision 0003): the routes we use, as the pinned version answers
// them. Skipped unless CONTRACK_LIVE_URL is set; it needs a fresh Contrack with sign-in on and no
// account yet (it makes the accounts and tokens itself):
//
//   docker run -d --rm --name contrack-live -p 127.0.0.1:3210:3210 -e AUTH_REQUIRED=true \
//     ghcr.io/arvarik/contrack:2.0.2
//   CONTRACK_LIVE_URL=http://127.0.0.1:3210 pnpm vitest run apps/api/test/contrack-live.test.ts
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactNames } from '../src/contacts/book.ts';
import { loadPhonebook } from '../src/provisioning/context.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const LIVE = process.env.CONTRACK_LIVE_URL;
type Req = (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;

/** Contrack's own API, signed in with a session cookie (accounts, tokens) or a token. */
async function ctk(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; token?: string } = {},
) {
  const r = await fetch(`${LIVE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.cookie ? { Cookie: init.cookie } : {}),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return {
    status: r.status,
    body: (await r.json().catch(() => null)) as Record<string, unknown>,
    cookie,
  };
}

const PASSWORD = 'Correct-horse-battery-9';

/** A Contrack account's read-write personal token that never expires. */
async function tokenOf(cookie: string, name: string) {
  const t = await ctk('/api/auth/tokens', { method: 'POST', cookie, body: { name } });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  return t.body.token as string;
}

/** An admin makes a member, who signs in, sets their own password, and makes a token. */
async function member(adminCookie: string, username: string) {
  const u = await ctk('/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      email: `${username}@example.com`,
      username,
      displayName: username,
      temporaryPassword: 'Temporary-pass-123',
    },
  });
  expect(u.status, JSON.stringify(u.body)).toBe(201);
  const login = await ctk('/api/auth/login', {
    method: 'POST',
    body: { identifier: username, password: 'Temporary-pass-123' },
  });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const ch = await ctk('/api/auth/change-password', {
    method: 'POST',
    cookie: login.cookie,
    body: { currentPassword: 'Temporary-pass-123', newPassword: PASSWORD },
  });
  expect(ch.status, JSON.stringify(ch.body)).toBeLessThan(300);
  const again = await ctk('/api/auth/login', {
    method: 'POST',
    body: { identifier: username, password: PASSWORD },
  });
  return tokenOf(again.cookie, 'SelfPhoneNG');
}

describe.skipIf(!hasTestDb || !LIVE)('contacts in a real Contrack', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: Req;
  let dan: Req;
  let sue: Req;
  let danId: string;
  const tok = { company: '', dan: '', sue: '' };

  beforeAll(async () => {
    // Contrack: the first account is the company's (and Contrack's admin); Dan and Sue are members.
    const setup = await ctk('/api/auth/setup', {
      method: 'POST',
      body: {
        email: 'company@example.com',
        username: 'company',
        password: PASSWORD,
        displayName: 'Company',
      },
    });
    expect(setup.status, `needs a fresh Contrack: ${JSON.stringify(setup.body)}`).toBe(201);
    tok.company = await tokenOf(setup.cookie, 'SelfPhoneNG company');
    tok.dan = await member(setup.cookie, 'dan');
    tok.sue = await member(setup.cookie, 'sue');
    for (const [token, body] of [
      [tok.company, { name: 'Plumber', phones: ['+1 312 555 7777'] }],
      [
        tok.dan,
        {
          name: 'Jane Doe',
          company: 'Acme',
          emails: [{ email: 'jane@acme.example' }],
          phones: [{ phone: '(312) 555-1234', label: 'mobile' }, 'front desk ext 123'],
        },
      ],
    ] as const) {
      const c = await ctk('/api/contacts', { method: 'POST', token, body });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
    }

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
  }, 60_000);
  afterAll(() => t?.close());

  it('Test, then save: Contrack answers and reads the company account', async () => {
    expect(
      (
        await admin('POST', '/api/contacts/contrack/test', { url: LIVE, companyToken: tok.company })
      ).json(),
    ).toEqual({
      ok: true,
      detail: 'Contrack answers; the token reads 1 contact.',
    });
    expect(
      (
        await admin('POST', '/api/contacts/contrack/test', {
          url: LIVE,
          companyToken: 'ctk_wrong_token',
        })
      ).json(),
    ).toEqual({
      ok: false,
      error: 'Contrack refused the token',
    });
    const r = await admin('PATCH', '/api/settings', {
      'contacts.provider': 'contrack',
      'contacts.contrack': {
        url: LIVE,
        publicUrl: 'https://contacts.example.com',
        companyToken: tok.company,
      },
    });
    expect(r.statusCode, r.body).toBe(200);
  });

  it('a person connects; their book and the company book come from Contrack', async () => {
    expect((await dan('PUT', '/api/me/contrack', { token: 'ctk_wrong_token' })).statusCode).toBe(
      400,
    );
    expect(
      (await dan('PUT', '/api/me/contrack', { token: tok.dan })).json().contrack.connected,
    ).toBe(true);
    const book = (await dan('GET', '/api/me/contacts')).json();
    expect(book.contrack).toEqual({
      publicUrl: 'https://contacts.example.com',
      connected: true,
      error: null,
    });
    expect(book.items).toEqual([
      expect.objectContaining({
        book: 'mine',
        name: 'Jane Doe',
        company: 'Acme',
        email: 'jane@acme.example',
        numbers: [{ label: '', number: '13125551234' }],
        url: expect.stringMatching(
          /^https:\/\/contacts\.example\.com\/contact\/jane-doe-[0-9a-f]{8}$/,
        ),
      }),
      expect.objectContaining({
        book: 'company',
        name: 'Plumber',
        numbers: [{ label: '', number: '13125557777' }],
      }),
    ]);
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

  it('Add to contacts lands in Contrack, with its label', async () => {
    const r = await dan('POST', '/api/me/contacts', {
      name: 'Bob Smith',
      company: 'Widgets',
      email: 'bob@widgets.example',
      numbers: [{ label: 'work', number: '312-555-9999' }],
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    const full = await ctk(`/api/contacts/${id}`, { token: tok.dan });
    expect(full.body).toMatchObject({
      name: 'Bob Smith',
      company: 'Widgets',
      emails: [expect.objectContaining({ email: 'bob@widgets.example' })],
      phones: [expect.objectContaining({ phone: '13125559999', label: 'work' })],
    });
    expect(
      (await dan('GET', '/api/me/contacts')).json().items.map((c: { name: string }) => c.name),
    ).toContain('Bob Smith');
  });

  it('a share is accepted into the recipient’s own Contrack account', async () => {
    const jane = (await dan('GET', '/api/me/contacts'))
      .json()
      .items.find((c: { name: string }) => c.name === 'Jane Doe');
    await dan('POST', '/api/me/contacts/share', { contactIds: [jane.id], extensions: ['102'] });
    const [offer] = (await sue('GET', '/api/me/contacts/shares')).json().items;
    expect(
      (await sue('POST', '/api/me/contacts/shares/accept', { ids: [offer.id] })).statusCode,
    ).toBe(409);
    await sue('PUT', '/api/me/contrack', { token: tok.sue });
    expect(
      (await sue('POST', '/api/me/contacts/shares/accept', { ids: [offer.id] })).json(),
    ).toEqual({ added: 1, duplicates: 0 });
    const sues = (await ctk('/api/contacts?view=slim', { token: tok.sue })).body as unknown as {
      name: string;
    }[];
    expect(sues.map((c) => c.name)).toEqual(['Jane Doe']);
    // Dan's account is untouched: Sue got a copy.
    const dans = (await ctk('/api/contacts?view=slim', { token: tok.dan })).body as unknown as {
      name: string;
    }[];
    expect(dans.map((c) => c.name).sort()).toEqual(['Bob Smith', 'Jane Doe']);
  });
});
