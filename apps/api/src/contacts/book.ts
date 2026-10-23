// SPDX-License-Identifier: AGPL-3.0-or-later
// The builtin address books (11 §3): a user's (owner_user_id) and the company's (null).
// ponytail: builtin only. Contrack (C3) adds its provider here, behind the same functions.
import { asc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  normalizeNumber,
  type ContactData,
  type ContactDto,
  type ContactImportResult,
} from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { contacts } from '../db/schema.ts';
import { badRequest } from '../errors.ts';

/** null = the company book. */
export type Owner = string | null;
const inBook = (owner: Owner) =>
  owner ? eq(contacts.ownerUserId, owner) : isNull(contacts.ownerUserId);

type Row = typeof contacts.$inferSelect;
export const toDto = (r: Row): ContactDto => ({
  id: r.id,
  book: r.ownerUserId ? 'mine' : 'company',
  name: r.name,
  company: r.company,
  email: r.email,
  numbers: r.numbers as ContactData['numbers'],
  notes: r.notes,
});

/** Normalized numbers (00 §8); `bad` gets the ones that aren't phone numbers. */
export function cleanNumbers(c: ContactData, bad?: (n: string) => void): ContactData['numbers'] {
  const out: ContactData['numbers'] = [];
  for (const n of c.numbers)
    try {
      const number = normalizeNumber(n.number);
      if (!out.some((o) => o.number === number)) out.push({ label: n.label, number });
    } catch {
      if (!bad) throw badRequest(`"${n.number}" isn't a phone number`);
      bad(n.number);
    }
  return out;
}

/** My contacts, then the company's, by name. */
export async function listBooks(db: Db, userId: string): Promise<ContactDto[]> {
  const rows = await db
    .select()
    .from(contacts)
    .where(or(eq(contacts.ownerUserId, userId), isNull(contacts.ownerUserId)))
    .orderBy(sql`${contacts.ownerUserId} is null`, asc(contacts.name));
  return rows.map(toDto);
}

export async function listBook(db: Db, owner: Owner): Promise<ContactDto[]> {
  return (await db.select().from(contacts).where(inBook(owner)).orderBy(asc(contacts.name))).map(
    toDto,
  );
}

/** Same contact: same name (any case) and a number in common, or neither has a number. */
const sameKey = (c: ContactData) => c.name.trim().toLowerCase();
const isDuplicate = (a: ContactData, b: ContactData) =>
  sameKey(a) === sameKey(b) &&
  ((!a.numbers.length && !b.numbers.length) ||
    a.numbers.some((n) => b.numbers.some((m) => m.number === n.number)));

/**
 * Adds contacts to a book, skipping ones it already has (11 §3.1). With `commit` false it only
 * counts. Bad numbers are dropped and reported.
 */
export async function addToBook(
  db: Pick<Db, 'select' | 'insert'>, // a transaction too
  owner: Owner,
  list: ContactData[],
  commit: boolean,
  errors: string[] = [],
): Promise<ContactImportResult> {
  const have = (await db.select().from(contacts).where(inBook(owner))).map(toDto);
  const fresh: ContactData[] = [];
  let duplicates = 0;
  for (const c of list) {
    const numbers = cleanNumbers(c, (n) =>
      errors.push(`${c.name}: "${n}" isn't a phone number, left out`),
    );
    const clean = { ...c, numbers };
    if ([...have, ...fresh].some((h) => isDuplicate(h, clean))) duplicates++;
    else fresh.push(clean);
  }
  // ponytail: one insert of up to 5,000 rows (the import cap).
  if (commit && fresh.length)
    await db.insert(contacts).values(fresh.map((c) => ({ ...c, ownerUserId: owner })));
  return {
    committed: commit,
    added: fresh.length,
    duplicates,
    noNumber: fresh.filter((c) => !c.numbers.length).length,
    errors: errors.slice(0, 20),
  };
}

/**
 * Names for numbers, from my book first, then the company's (11 §1). Numbers as calls store them
 * (normalized).
 */
export async function contactNames(
  db: Db,
  userId: string | null,
  numbers: (string | null)[],
): Promise<Map<string, string>> {
  const want = [...new Set(numbers.filter((n): n is string => !!n))];
  const out = new Map<string, string>();
  if (!want.length) return out;
  // ponytail: a scan of the two books' numbers; a GIN index when books reach tens of thousands.
  const { rows } = await db.execute<{ name: string; number: string; mine: boolean }>(sql`
    select c.name, n->>'number' as number, c.owner_user_id is not null as mine
    from ${contacts} c, jsonb_array_elements(c.numbers) n
    where ${userId ? sql`(c.owner_user_id = ${userId} or c.owner_user_id is null)` : sql`c.owner_user_id is null`}
      and n->>'number' in ${want}`);
  for (const r of rows.sort((a, b) => Number(b.mine) - Number(a.mine)))
    if (!out.has(r.number)) out.set(r.number, r.name);
  return out;
}
