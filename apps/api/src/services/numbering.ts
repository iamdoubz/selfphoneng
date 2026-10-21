// SPDX-License-Identifier: AGPL-3.0-or-later
// One namespace for every internal number (00 §7, 04 §7.2).
import { and, eq, ne } from 'drizzle-orm';
import { isReservedNumber, type NumberKind } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import {
  conferences,
  extensions,
  ivrOptions,
  ivrs,
  pagingGroups,
  queues,
  ringGroups,
} from '../db/schema.ts';
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
export async function ownerOf(db: Db, number: string, excludeId?: string): Promise<string | null> {
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

/**
 * A digital receptionist that lets callers dial numbers and has `key` in its menu: callers pressing
 * it get the menu option, so a one-digit number `key` can't be dialed from there.
 */
export async function menuKeyOwner(db: Db, key: string, excludeIvrId?: string) {
  if (!/^\d$/.test(key)) return null;
  const [row] = await db
    .select({ name: ivrs.name })
    .from(ivrOptions)
    .innerJoin(ivrs, eq(ivrs.id, ivrOptions.ivrId))
    .where(
      and(
        eq(ivrOptions.digit, key),
        eq(ivrs.allowDirectDial, true),
        ...(excludeIvrId ? [ne(ivrs.id, excludeIvrId)] : []),
      ),
    )
    .limit(1);
  return row?.name ?? null;
}

/**
 * Any free internal number, for any kind (owner, 2026-10-21): the numbering ranges only choose the
 * suggested next number (nextFreeNumber). `kind` is kept for that and for callers' readability.
 */
export async function assertNumberAvailable(
  db: Db,
  number: string,
  _kind: NumberKind,
  excludeId?: string,
): Promise<void> {
  if (!/^\d{1,6}$/.test(number)) throw badRequest('Internal numbers have 1 to 6 digits');
  if (isReservedNumber(number))
    throw badRequest(`${number} is reserved (emergency and service codes can't be used)`);
  const owner = await ownerOf(db, number, excludeId);
  if (owner) throw conflict(`${number} is already used by ${owner}`, { owner });
  const menu = await menuKeyOwner(db, number);
  if (menu)
    throw conflict(
      `${number} is a menu key of the digital receptionist "${menu}", which also lets callers dial numbers: pressing ${number} there would always choose the menu option`,
      { owner: `digital receptionist "${menu}"` },
    );
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
