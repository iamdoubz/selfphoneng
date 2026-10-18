// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T8: /api/blocked-numbers and the AstDB mirror (04 §5.5).
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncAstDb } from '../src/services/astdb.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('/api/blocked-numbers', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    req = (method, url, payload) =>
      t.app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { ...H, cookie },
      });
  });
  afterAll(() => t?.close());

  it('blocks a number in any format (stored normalized), mirrors AstDB, unblocks', async () => {
    const r = await req('POST', '/api/blocked-numbers', {
      number: '(312) 555-0199',
      reason: 'Spam',
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ number: '13125550199', reason: 'Spam' });
    expect(t.ami.actions.at(-1)).toEqual({
      Action: 'DBPut',
      Family: 'SP',
      Key: 'BLOCK/13125550199',
      Val: '1',
    });
    expect(
      (await req('POST', '/api/blocked-numbers', { number: '+1 312 555 0199' })).statusCode,
    ).toBe(409);
    expect((await req('POST', '/api/blocked-numbers', { number: 'spam' })).statusCode).toBe(400);

    t.ami.actions.length = 0;
    await syncAstDb(t.db, t.ami);
    expect(t.ami.actions).toContainEqual({
      Action: 'DBPut',
      Family: 'SP',
      Key: 'BLOCK/13125550199',
      Val: '1',
    });

    expect((await req('DELETE', `/api/blocked-numbers/${r.json().id}`)).statusCode).toBe(200);
    expect(t.ami.actions.at(-1)).toEqual({
      Action: 'DBDel',
      Family: 'SP',
      Key: 'BLOCK/13125550199',
    });
    expect((await req('GET', '/api/blocked-numbers')).json().items).toEqual([]);
  });
});
