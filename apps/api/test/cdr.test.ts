// SPDX-License-Identifier: AGPL-3.0-or-later
// M7-T1: each recorded scenario (test/fixtures/cdr, from real calls) produces the expected calls row.
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AmiMessage } from '../src/ami/events.ts';
import { callExtensions, calls, cdr, dids, extensions, trunks } from '../src/db/schema.ts';
import { aggregateCall, toCdrRow } from '../src/services/cdr.ts';
import { encrypt } from '../src/crypto/secrets.ts';
import { hasTestDb } from './db.ts';
import { createTestApp } from './app.ts';

const fixture = (name: string): AmiMessage[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/cdr/${name}.json`, import.meta.url), 'utf8'));

type Expected = {
  direction: string;
  status: string;
  fromNumber: string;
  fromName: string | null;
  toNumber: string;
  did?: string;
  answeredBy: string | null;
  rang: string[];
  talkSeconds: number;
};

const SCENARIOS: Record<string, Expected> = {
  'internal-answered': {
    direction: 'internal',
    status: 'answered',
    fromNumber: '103',
    fromName: 'Carol',
    toNumber: '101',
    answeredBy: '101',
    rang: ['101'],
    talkSeconds: 5,
  },
  'internal-voicemail': {
    direction: 'internal',
    status: 'voicemail',
    fromNumber: '103',
    fromName: 'Carol',
    toNumber: '102',
    answeredBy: null,
    rang: ['102'],
    talkSeconds: 0,
  },
  'internal-unavailable': {
    direction: 'internal',
    status: 'missed',
    fromNumber: '103',
    fromName: 'Carol',
    toNumber: '104',
    answeredBy: null,
    rang: [],
    talkSeconds: 0,
  },
  'inbound-user': {
    direction: 'inbound',
    status: 'answered',
    fromNumber: '13125559999',
    fromName: 'Mobile',
    toNumber: '13125551234',
    did: '13125551234',
    answeredBy: '101',
    rang: ['101'],
    talkSeconds: 5,
  },
  'inbound-ringgroup': {
    direction: 'inbound',
    status: 'answered',
    fromNumber: '13125559999',
    fromName: 'Mobile',
    toNumber: '13125551235',
    did: '13125551235',
    answeredBy: '103',
    rang: ['102', '103'],
    talkSeconds: 4,
  },
  'inbound-ivr-voicemail': {
    direction: 'inbound',
    status: 'voicemail',
    fromNumber: '13125559999',
    fromName: 'Mobile',
    toNumber: '13125551236',
    did: '13125551236',
    answeredBy: null,
    rang: [],
    talkSeconds: 0,
  },
  'outbound-answered': {
    direction: 'outbound',
    status: 'answered',
    fromNumber: '101',
    fromName: 'Alice',
    toNumber: '13125550000',
    answeredBy: null,
    rang: [],
    talkSeconds: 5,
  },
  transfer: {
    direction: 'inbound',
    status: 'answered',
    fromNumber: '13125559999',
    fromName: 'Mobile',
    toNumber: '13125551234',
    did: '13125551234',
    answeredBy: '101',
    rang: ['101', '103'],
    talkSeconds: 4,
  },
};

describe.skipIf(!hasTestDb)('call aggregation from recorded CDRs', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const extId: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestApp();
    for (const [n, name] of [
      ['101', 'Alice'],
      ['102', 'Bob'],
      ['103', 'Carol'],
      ['104', 'Dave'],
    ] as const) {
      const [e] = await t.db
        .insert(extensions)
        .values({ number: n, name, sipPasswordEnc: encrypt('x'), voicemailPinEnc: encrypt('4826') })
        .returning();
      extId[n] = e!.id;
    }
    const [trunk] = await t.db
      .insert(trunks)
      .values({
        name: 'voip.ms',
        serverHost: 'chicago1.voip.ms',
        username: 'u',
        passwordEnc: encrypt('p'),
      })
      .returning();
    for (const n of ['1234', '1235', '1236'])
      await t.db.insert(dids).values({
        number: `1312555${n}`,
        trunkId: trunk!.id,
        destination: { type: 'hangup' },
      });
  });
  afterAll(() => t?.close());

  it.each(Object.entries(SCENARIOS))('%s', async (name, want) => {
    const events = fixture(name);
    for (const e of events) await t.db.insert(cdr).values(toCdrRow(e));
    const linkedid = String(events[0]!.LinkedID);
    await aggregateCall(t.db, linkedid);
    await aggregateCall(t.db, linkedid); // idempotent
    const rows = await t.db.select().from(calls).where(eq(calls.linkedid, linkedid));
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    expect({
      direction: c.direction,
      status: c.status,
      fromNumber: c.fromNumber,
      fromName: c.fromName,
      toNumber: c.toNumber,
      talkSeconds: c.talkSeconds,
    }).toEqual({
      direction: want.direction,
      status: want.status,
      fromNumber: want.fromNumber,
      fromName: want.fromName,
      toNumber: want.toNumber,
      talkSeconds: want.talkSeconds,
    });
    expect(c.answeredByExtensionId).toBe(want.answeredBy ? extId[want.answeredBy] : null);
    expect(c.didId !== null).toBe(Boolean(want.did));
    expect(c.startedAt.getTime()).toBeLessThanOrEqual(c.endedAt.getTime());
    expect(c.answeredAt !== null).toBe(want.status === 'answered');
    const involved = await t.db
      .select({ ext: callExtensions.extensionId, role: callExtensions.role })
      .from(callExtensions)
      .where(eq(callExtensions.callId, c.id));
    expect(
      involved
        .filter((i) => i.role === 'rang')
        .map((i) => i.ext)
        .sort(),
    ).toEqual(want.rang.map((n) => extId[n]).sort());
    const caller = /^\d{3}$/.test(want.fromNumber) ? [extId[want.fromNumber]] : [];
    expect(involved.filter((i) => i.role === 'caller').map((i) => i.ext)).toEqual(caller);
  });
});
