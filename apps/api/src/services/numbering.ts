// SPDX-License-Identifier: AGPL-3.0-or-later
// One namespace for every internal number (00 §7, 04 §7.2).
import { and, eq, ne } from 'drizzle-orm';
import { isReservedNumber, type NumberKind } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { conferences, extensions, ivrs, pagingGroups, queues, ringGroups } from '../db/schema.ts';
import { badRequest, conflict } from '../errors.ts';
import { getSetting } from './settings.ts';

const RANGE_KEY = {
  user: 'numbering.users',
  ringGroup: 'numbering.ringGroups',
  queue: 'numbering.queues',
  ivr: 'numbering.ivrs',
  conference: 'numbering.conferences',
  paging: 'numbering.paging',
} as const;

const OWNERS = [
  { table: extensions, label: 'extension' },
  { table: ringGroups, label: 'ring group' },
  { table: queues, label: 'queue' },
  { table: ivrs, label: 'IVR' },
  { table: conferences, label: 'conference room' },
  { table: pagingGroups, label: 'paging group' },
] as const;

const PARKING = { from: 700, to: 720 }; // res_parking.conf: 700 + slots 701–720

/** Who holds `number` right now (ignoring row `excludeId`), or null. */
async function ownerOf(db: Db, number: string, excludeId?: string): Promise<string | null> {
  const n = Number(number);
  if (n >= PARKING.from && n <= PARKING.to) return 'parking';
  for (const { table, label } of OWNERS) {
    const [row] = await db
      .select({ id: table.id, name: table.name })
      .from(table)
      .where(
        excludeId
          ? and(eq(table.number, number), ne(table.id, excludeId))
          : eq(table.number, number),
      )
      .limit(1);
    if (row) return `${label} "${row.name}"`;
  }
  return null;
}

export async function assertNumberAvailable(
  db: Db,
  number: string,
  kind: NumberKind,
  excludeId?: string,
): Promise<void> {
  if (!/^\d{3,6}$/.test(number)) throw badRequest('Internal numbers have 3 to 6 digits');
  if (isReservedNumber(number))
    throw badRequest(`${number} is reserved (emergency and service codes can't be used)`);
  const [from, to] = await getSetting(db, RANGE_KEY[kind]);
  const n = Number(number);
  if (n < from || n > to) throw badRequest(`Use a number from ${from} to ${to}`);
  const owner = await ownerOf(db, number, excludeId);
  if (owner) throw conflict(`${number} is already used by ${owner}`, { owner });
}

/** Lowest free number in the kind's range, or null when the range is full. */
export async function nextFreeNumber(db: Db, kind: NumberKind): Promise<string | null> {
  const [from, to] = await getSetting(db, RANGE_KEY[kind]);
  const taken = new Set<string>();
  for (const { table } of OWNERS)
    for (const r of await db.select({ number: table.number }).from(table)) taken.add(r.number);
  for (let n = from; n <= to; n++) {
    const s = String(n);
    if (n >= PARKING.from && n <= PARKING.to) continue;
    if (!taken.has(s) && !isReservedNumber(s)) return s;
  }
  return null;
}
