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
import { eq } from 'drizzle-orm';
import { contactNames } from '../src/contacts/book.ts';
import { logCallsToContrack } from '../src/contacts/timeline.ts';
import {
  callExtensions,
  calls,
  contacts,
  extensions,
  recordings,
  users,
} from '../src/db/schema.ts';
import { setSetting } from '../src/services/settings.ts';
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
      toCopy: 0,
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

  it('a call with Jane lands on her Contrack timeline, with the summary and a follow-up (C5)', async () => {
    const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);
    await t.db
      .update(users)
      .set({ contrackLogSince: at(60) })
      .where(eq(users.id, danId));
    await setSetting(t.db, 'ai.callTranscripts', true);
    await setSetting(t.db, 'ai.callSummaries', true);
    expect((await dan('PATCH', '/api/me/contrack', { logSummaries: true })).statusCode).toBe(200);
    const [ext] = await t.db.select().from(extensions).where(eq(extensions.number, '101'));
    const [rec] = await t.db
      .insert(recordings)
      .values({
        linkedid: 'live-r1',
        filePath: 'live-r1.wav',
        startedAt: at(20),
        summary:
          'Jane asked for a <quote> & delivery dates.\nAction items:\n- Dan sends the quote by Friday',
        aiDoneAt: at(15),
      })
      .returning();
    const [c] = await t.db
      .insert(calls)
      .values({
        linkedid: 'live-c1',
        direction: 'inbound',
        status: 'answered',
        startedAt: at(20),
        endedAt: at(17),
        fromNumber: '13125551234',
        toNumber: '13125550000',
        talkSeconds: 185,
        answeredByExtensionId: ext!.id,
        recordingId: rec!.id,
      })
      .returning();
    await t.db
      .insert(callExtensions)
      .values({ callId: c!.id, extensionId: ext!.id, role: 'answered' });
    expect(await logCallsToContrack({ db: t.db, log: t.app.log })).toBe(1);
    expect(await logCallsToContrack({ db: t.db, log: t.app.log })).toBe(0);

    const jane = (
      (await ctk('/api/contacts?view=slim', { token: tok.dan })).body as unknown as {
        id: string;
        name: string;
      }[]
    ).find((x) => x.name === 'Jane Doe')!;
    const timeline = (await ctk(`/api/contacts/${jane.id}/timeline`, { token: tok.dan }))
      .body as unknown as Record<string, unknown>[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      type: 'call',
      title: 'Incoming call',
      date: c!.startedAt.toISOString(),
      duration: expect.anything(), // Contrack answers it as "4.0"
      actionItems: [
        expect.objectContaining({ title: 'Dan sends the quote by Friday', completedAt: null }),
      ],
    });
    expect(Number(timeline[0]!.duration)).toBe(4);
    const content = String(timeline[0]!.content);
    expect(content).toContain('From (312) 555-1234 to (312) 555-0000 · 3:05 · recorded');
    expect(content).toContain('Jane asked for a &lt;quote&gt; &amp; delivery dates.');
    expect(content).toContain('<li>Dan sends the quote by Friday</li>');
    expect(content).not.toContain('<quote>');
  });

  it('contacts from before Contrack copy into the account in one import (C6)', async () => {
    await t.db.insert(contacts).values([
      {
        name: 'Old Friend',
        ownerUserId: danId,
        numbers: [{ label: 'home', number: '13125550202' }],
      },
      { name: 'Jane Doe', ownerUserId: danId, numbers: [{ label: '', number: '13125551234' }] },
    ]);
    expect((await dan('GET', '/api/me/contacts')).json().contrack.toCopy).toBe(1);
    const r = await dan('POST', '/api/me/contacts/copy-to-contrack');
    expect(r.json(), r.body).toEqual({ added: 1, duplicates: 1, failed: 0 });
    const rows = (await ctk('/api/contacts?view=slim', { token: tok.dan })).body as unknown as {
      name: string;
      phones: { phone: string }[];
    }[];
    expect(rows.find((x) => x.name === 'Old Friend')?.phones).toEqual([{ phone: '13125550202' }]);
    expect((await dan('GET', '/api/me/contacts')).json().contrack.toCopy).toBe(0);
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
    expect(dans.map((c) => c.name).sort()).toEqual(['Bob Smith', 'Jane Doe', 'Old Friend']);
  });
});
