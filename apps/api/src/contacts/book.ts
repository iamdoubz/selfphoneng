// SPDX-License-Identifier: AGPL-3.0-or-later
// Address books (11 §2): a user's (owner = their id) and the company's (owner null), kept in the
// `contacts` table (builtin) or in Contrack (contacts.provider = 'contrack', 11 §4). Every caller
// goes through these functions and doesn't care which.
import { asc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  normalizeNumber,
  type ContactBookDto,
  type ContactData,
  type ContactDto,
  type ContactImportResult,
} from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { contacts } from '../db/schema.ts';
import { HttpError, badRequest } from '../errors.ts';
import {
  ContrackError,
  contrackBook,
  contrackCreate,
  contrackSettings,
  needToken,
  type Contrack,
} from './contrack.ts';

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
  url: null,
});

/** Contrack's errors as API answers (409 for "connect first", 502 for Contrack itself). */
const asHttp = (err: unknown): never => {
  if (err instanceof ContrackError)
    throw new HttpError(err.status === 409 ? 409 : 502, 'contrack', err.message);
  throw err;
};

/** Editing, deleting and importing happen in Contrack itself in Contrack mode (11 §3.1, §4.3). */
export async function assertBuiltin(db: Db) {
  if (await contrackSettings(db))
    throw new HttpError(409, 'contrack', 'Contacts live in Contrack: change them there');
}

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

const byName = (a: ContactDto, b: ContactDto) => a.name.localeCompare(b.name);

async function contrackList(db: Db, c: Contrack, owner: Owner) {
  const b = await contrackBook(db, c, owner);
  return { items: (b?.contacts ?? []).toSorted(byName), book: b };
}

/**
 * The books someone sees: my contacts, then the company's (userId), or only the company's (null,
 * Admin → Contacts). `contrack` says whether that person's (or the company's) token works.
 */
export async function readBooks(db: Db, userId: string | null): Promise<ContactBookDto> {
  const c = await contrackSettings(db);
  if (!c) {
    const rows = await db
      .select()
      .from(contacts)
      .where(
        userId
          ? or(eq(contacts.ownerUserId, userId), isNull(contacts.ownerUserId))
          : isNull(contacts.ownerUserId),
      )
      .orderBy(sql`${contacts.ownerUserId} is null`, asc(contacts.name));
    return { items: rows.map(toDto), provider: 'builtin', contrack: null };
  }
  const company = await contrackList(db, c, null);
  const mine = userId ? await contrackList(db, c, userId) : null;
  const own = mine ?? company; // whose token the page is about
  return {
    items: [...(mine?.items ?? []), ...company.items],
    provider: 'contrack',
    contrack: {
      publicUrl: c.publicUrl,
      connected: !!own.book && !own.book.error,
      error: own.book?.error ?? null,
    },
  };
}

/** One contact added by hand (or from a call): a row, or a Contrack contact. */
export async function createContact(db: Db, owner: Owner, d: ContactData): Promise<ContactDto> {
  const clean = { ...d, numbers: cleanNumbers(d) };
  const c = await contrackSettings(db);
  if (c) return contrackCreate(db, c, owner, clean).catch(asHttp);
  const [row] = await db
    .insert(contacts)
    .values({ ...clean, ownerUserId: owner })
    .returning();
  return toDto(row!);
}

/** Same contact: same name (any case) and a number in common, or neither has a number. */
const sameKey = (c: ContactData) => c.name.trim().toLowerCase();
const isDuplicate = (a: ContactData, b: ContactData) =>
  sameKey(a) === sameKey(b) &&
  ((!a.numbers.length && !b.numbers.length) ||
    a.numbers.some((n) => b.numbers.some((m) => m.number === n.number)));

/**
 * Adds contacts to a book, skipping ones it already has (11 §3.1): an import or accepted shares.
 * With `commit` false it only counts. Bad numbers are dropped and reported.
 */
export async function addToBook(
  db: Db,
  owner: Owner,
  list: ContactData[],
  commit: boolean,
  errors: string[] = [],
): Promise<ContactImportResult> {
  const c = await contrackSettings(db);
  let have: ContactDto[];
  if (c) {
    const b = await contrackBook(db, c, owner);
    if (!b) asHttp(needToken(owner));
    if (b!.error) throw new HttpError(502, 'contrack', b!.error);
    have = b!.contacts;
  } else have = (await db.select().from(contacts).where(inBook(owner))).map(toDto);
  const fresh: ContactData[] = [];
  let duplicates = 0;
  for (const d of list) {
    const numbers = cleanNumbers(d, (n) =>
      errors.push(`${d.name}: "${n}" isn't a phone number, left out`),
    );
    const clean = { ...d, numbers };
    if ([...have, ...fresh].some((h) => isDuplicate(h, clean))) duplicates++;
    else fresh.push(clean);
  }
  if (commit && fresh.length) {
    // ponytail: one Contrack request per contact; imports go to Contrack's own importer, so
    // this is only accepted shares.
    if (c) for (const d of fresh) await contrackCreate(db, c, owner, d).catch(asHttp);
    // ponytail: one insert of up to 5,000 rows (the import cap).
    else await db.insert(contacts).values(fresh.map((d) => ({ ...d, ownerUserId: owner })));
  }
  return {
    committed: commit,
    added: fresh.length,
    duplicates,
    noNumber: fresh.filter((d) => !d.numbers.length).length,
    errors: errors.slice(0, 20),
  };
}

/**
 * Names for numbers, from my book first, then the company's (11 §1). Numbers as calls store them
 * (normalized). userId null: the company book only.
 */
export async function contactNames(
  db: Db,
  userId: string | null,
  numbers: (string | null)[],
): Promise<Map<string, string>> {
  const want = [...new Set(numbers.filter((n): n is string => !!n))];
  const out = new Map<string, string>();
  if (!want.length) return out;
  const c = await contrackSettings(db);
  if (c) {
    const books = [
      userId ? await contrackBook(db, c, userId) : null,
      await contrackBook(db, c, null),
    ];
    for (const b of books)
      for (const ct of b?.contacts ?? [])
        for (const n of ct.numbers)
          if (want.includes(n.number) && !out.has(n.number)) out.set(n.number, ct.name);
    return out;
  }
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
