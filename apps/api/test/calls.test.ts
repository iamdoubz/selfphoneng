// SPDX-License-Identifier: AGPL-3.0-or-later
// M7-T2: /api/calls (filters, paging, detail, CSV) and /api/me/calls, on the recorded CDR fixtures.
import { readdirSync, readFileSync } from 'node:fs';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AmiMessage } from '../src/ami/events.ts';
import { cdr, dids, extensions, trunks } from '../src/db/schema.ts';
import { encrypt } from '../src/crypto/secrets.ts';
import { aggregateCall, toCdrRow } from '../src/services/cdr.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const FIXTURES = new URL('./fixtures/cdr/', import.meta.url);

describe.skipIf(!hasTestDb)('call history API', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: (url: string) => Promise<LightMyRequestResponse>;
  let carol: (url: string) => Promise<LightMyRequestResponse>;
  const ext: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const carolUser = await t.addUser('carol@example.com', 'carol-password-123');
    for (const [n, name] of [
      ['101', 'Alice'],
      ['102', 'Bob'],
      ['103', 'Carol'],
      ['104', 'Dave'],
    ] as const) {
      const [e] = await t.db
        .insert(extensions)
        .values({
          number: n,
          name,
          sipPasswordEnc: encrypt('x'),
          voicemailPinEnc: encrypt('4826'),
          userId: n === '103' ? carolUser.id : null,
        })
        .returning();
      ext[n] = e!.id;
    }
    const [trunk] = await t.db
      .insert(trunks)
      .values({
        name: 'voip.ms',
        serverHost: 'x.voip.ms',
        username: 'u',
        passwordEnc: encrypt('p'),
      })
      .returning();
    for (const n of ['1234', '1235', '1236'])
      await t.db.insert(dids).values({
        number: `1312555${n}`,
        trunkId: trunk!.id,
        destination: { type: 'hangup' },
        label: n === '1234' ? 'Main line' : null,
      });
    for (const f of readdirSync(FIXTURES)) {
      const events: AmiMessage[] = JSON.parse(readFileSync(new URL(f, FIXTURES), 'utf8'));
      for (const e of events) await t.db.insert(cdr).values(toCdrRow(e));
      await aggregateCall(t.db, String(events[0]!.LinkedID));
    }
    const as = (cookie: string) => (url: string) =>
      t.app.inject({ method: 'GET', url, headers: { ...H, cookie } });
    admin = as(await t.login(ADMIN.email, ADMIN.password));
    carol = as(await t.login('carol@example.com', 'carol-password-123'));
  });
  afterAll(() => t?.close());

  const list = async (q = '') => (await admin(`/api/calls${q}`)).json();

  it('lists every call newest first, with the DID and who answered', async () => {
    const r = await list();
    expect(r.items).toHaveLength(8);
    const starts = r.items.map((c: { startedAt: string }) => c.startedAt);
    expect([...starts].sort().reverse()).toEqual(starts);
    const inbound = r.items.find(
      (c: { did: { label: string } | null }) => c.did?.label === 'Main line',
    );
    expect(inbound).toMatchObject({
      direction: 'inbound',
      did: { number: '13125551234' },
      answeredBy: { number: '101', name: 'Alice' },
    });
  });

  it('filters by direction, status, number, extension and company-time-zone days', async () => {
    expect((await list('?direction=inbound')).items).toHaveLength(4);
    expect((await list('?status=voicemail')).items).toHaveLength(2);
    expect((await list('?q=(312) 555-9999')).items).toHaveLength(4);
    expect((await list(`?extensionId=${ext['102']}`)).items).toHaveLength(3); // incl. IVR → its mailbox
    expect((await list('?from=2026-10-18&to=2026-10-18')).items).toHaveLength(8);
    expect((await list('?from=2026-10-19')).items).toHaveLength(0);
    expect((await admin('/api/calls?status=lost')).statusCode).toBe(400);
  });

  it('pages with a cursor without repeats', async () => {
    const seen: string[] = [];
    let url = '/api/calls?limit=3';
    for (;;) {
      const r = (await admin(url)).json();
      seen.push(...r.items.map((c: { id: string }) => c.id));
      if (!r.nextCursor) break;
      url = `/api/calls?limit=3&cursor=${r.nextCursor}`;
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  it('a call expands to its CDR legs', async () => {
    const rg = (await list('?q=5551235')).items[0];
    const d = (await admin(`/api/calls/${rg.id}`)).json();
    expect(d.legs).toHaveLength(6);
    expect(d.legs.some((l: { dstchannel: string }) => l.dstchannel?.startsWith('PJSIP/103-'))).toBe(
      true,
    );
  });

  it('exports CSV with the same filters', async () => {
    const r = await admin('/api/calls/export.csv?direction=internal');
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    const lines = r.body.trim().split('\r\n');
    expect(lines[0]).toBe(
      'started,direction,status,from,from_name,to,phone_number,answered_by,talk_seconds',
    );
    expect(lines).toHaveLength(4);
    expect(lines.some((l) => /,internal,answered,103,Carol,101,,101 Alice,5$/.test(l))).toBe(true);
  });

  it('/api/me/calls: only my calls, with my side of each; admins-only list is closed to me', async () => {
    const r = (await carol('/api/me/calls')).json();
    expect(r.items).toHaveLength(5);
    expect(r.items.filter((c: { myRole: string }) => c.myRole === 'out')).toHaveLength(3);
    expect(r.items.every((c: { missedByMe: boolean }) => !c.missedByMe)).toBe(true);
    expect((await carol('/api/calls')).statusCode).toBe(403);
  });
});
