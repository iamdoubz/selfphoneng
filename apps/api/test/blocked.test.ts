// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T8: /api/blocked-numbers and the AstDB mirror (04 §5.5); users' Report spam (05 §4).
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callExtensions, calls, extensions } from '../src/db/schema.ts';
import { encrypt } from '../src/crypto/secrets.ts';
import { syncAstDb } from '../src/services/astdb.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('/api/blocked-numbers', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (
    method: string,
    url: string,
    payload?: unknown,
    as?: string,
  ) => Promise<LightMyRequestResponse>;

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    req = (method, url, payload, as = cookie) =>
      t.app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { ...H, cookie: as },
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

  it('Report spam: only on an outside call that rang me; Block clears it, Dismiss drops it', async () => {
    const sam = await t.addUser('sam@example.com', 'sam-password-123');
    await t.addUser('pat@example.com', 'pat-password-123');
    const [ext] = await t.db
      .insert(extensions)
      .values({
        number: '103',
        name: 'Sam',
        sipPasswordEnc: encrypt('x'),
        voicemailPinEnc: encrypt('4826'),
        userId: sam.id,
      })
      .returning();
    const call = async (linkedid: string, from: string | null, role: string) => {
      const [c] = await t.db
        .insert(calls)
        .values({
          linkedid,
          direction: 'inbound',
          status: 'answered',
          fromNumber: from,
          startedAt: new Date(),
          endedAt: new Date(),
        })
        .returning();
      await t.db.insert(callExtensions).values({ callId: c!.id, extensionId: ext!.id, role });
      return c!.id;
    };
    const robo = await call('r1', '13125550142', 'rang');
    const hidden = await call('r2', null, 'answered');
    const samC = await t.login('sam@example.com', 'sam-password-123');
    const patC = await t.login('pat@example.com', 'pat-password-123');
    const report = (callId: string, as: string, reason = 'Car warranty robocall') =>
      req('POST', '/api/me/spam-reports', { callId, reason }, as);

    expect((await report(robo, patC)).statusCode).toBe(404); // not a call that rang Pat
    expect((await report(robo, samC, ' ')).statusCode).toBe(400); // no reason
    expect((await report(hidden, samC)).statusCode).toBe(400); // no number to block
    expect((await report(robo, samC)).statusCode).toBe(201);
    expect((await report(robo, samC)).statusCode).toBe(409); // once each
    expect((await req('GET', '/api/spam-reports', undefined, samC)).statusCode).toBe(403);
    const [r] = (await req('GET', '/api/spam-reports')).json().items;
    expect(r).toMatchObject({
      number: '13125550142',
      reason: 'Car warranty robocall',
      reportedBy: 'sam@example.com',
    });

    expect((await req('DELETE', `/api/spam-reports/${r.id}`)).statusCode).toBe(200);
    expect((await req('GET', '/api/spam-reports')).json().items).toEqual([]);

    expect((await report(robo, samC)).statusCode).toBe(201); // dismissed: may report again
    const b = await req('POST', '/api/blocked-numbers', { number: r.number, reason: r.reason });
    expect(b.statusCode).toBe(201);
    expect((await req('GET', '/api/spam-reports')).json().items).toEqual([]);
    expect((await report(robo, samC)).statusCode).toBe(409); // already blocked
  });
});
