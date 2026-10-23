// SPDX-License-Identifier: AGPL-3.0-or-later
// Contrack (11 §4): a self-hosted contact manager beside the PBX. We call a handful of its REST
// routes with a person's (or the company account's) personal token, and keep each book in memory
// for 5 minutes, so name lookups don't wait on it.
import { eq } from 'drizzle-orm';
import { normalizeNumber, type ContactData, type ContactDto } from '@selfphoneng/shared';
import { AiError, assertLocalUrl } from '../ai/client.ts';
import { decrypt } from '../crypto/secrets.ts';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { getSetting } from '../services/settings.ts';

export class ContrackError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** One call to Contrack's API (base: the local address in Settings → Contacts). */
async function ctk<T>(
  base: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  try {
    assertLocalUrl(base);
  } catch (err) {
    throw new ContrackError((err as AiError).message);
  }
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  let r: Response;
  try {
    r = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    throw new ContrackError(
      e.name === 'TimeoutError'
        ? `Contrack (${url.host}) didn't answer within 10 s`
        : `Can't reach Contrack at ${url.host}${e.cause?.code ? ` (${e.cause.code})` : ''}`,
    );
  }
  if (r.status === 401) throw new ContrackError('Contrack refused the token', 401);
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ContrackError(`Contrack: ${body?.error?.message ?? `HTTP ${r.status}`}`, r.status);
  }
  return (await r.json()) as T;
}

type Slim = {
  id: string;
  name: string;
  company: string | null;
  emails: { email: string }[];
  phones: { phone: string }[];
};

export type Contrack = { url: string; publicUrl: string | null; companyToken: string | null };

/** Settings → Contacts, or null in builtin mode. */
export async function contrackSettings(db: Db): Promise<Contrack | null> {
  if ((await getSetting(db, 'contacts.provider')) !== 'contrack') return null;
  const c = await getSetting(db, 'contacts.contrack');
  if (!c) return null;
  return {
    url: c.url,
    publicUrl: c.publicUrl,
    companyToken: c.companyTokenEnc ? decrypt(c.companyTokenEnc) : null,
  };
}

/** The token for a book: a user's own, or the company account's (owner null). */
export async function tokenFor(db: Db, c: Contrack, owner: string | null): Promise<string | null> {
  if (owner === null) return c.companyToken;
  const [u] = await db
    .select({ enc: users.contrackTokenEnc })
    .from(users)
    .where(eq(users.id, owner));
  return u?.enc ? decrypt(u.enc) : null;
}

const toDto = (c: Contrack, s: Slim, book: ContactDto['book']): ContactDto => {
  const numbers: ContactData['numbers'] = [];
  for (const p of s.phones)
    try {
      const number = normalizeNumber(p.phone);
      if (!numbers.some((n) => n.number === number)) numbers.push({ label: '', number });
    } catch {
      // Not a number a phone can dial ("ask reception"): left out.
    }
  return {
    id: s.id,
    book,
    name: s.name,
    company: s.company,
    email: s.emails[0]?.email ?? null,
    numbers,
    notes: null,
    url: c.publicUrl ? `${c.publicUrl}/contact/${encodeURIComponent(s.id)}` : null,
  };
};

type Book = { contacts: ContactDto[]; at: number; error: string | null };
/** By owner: a user id, or '' for the company account. Keyed by token too, so a new one refetches. */
const cache = new Map<string, Book & { token: string }>();
const TTL = 5 * 60_000;

/** Forget a book (after we add to it, or a token changes). */
export const forgetBook = (owner: string | null) => cache.delete(owner ?? '');

const inflight = new Map<string, Promise<Book>>();

/**
 * A Contrack book, from the cache when it's under 5 minutes old. Null: no token. A failing
 * Contrack keeps the last good list and says why. `wait: false` (a phone ringing, 11 §6 C4)
 * never waits on Contrack: it answers what the cache has and refreshes in the background.
 */
export async function contrackBook(
  db: Db,
  c: Contrack,
  owner: string | null,
  { now = Date.now(), wait = true }: { now?: number; wait?: boolean } = {},
): Promise<Book | null> {
  const token = await tokenFor(db, c, owner);
  if (!token) return null;
  const key = owner ?? '';
  const hit = cache.get(key);
  const usable = hit && hit.token === token ? hit : undefined;
  if (usable && now - usable.at < TTL) return usable;
  if (!inflight.has(key))
    inflight.set(
      key,
      fetchBook(c, owner, token, usable, now).finally(() => inflight.delete(key)),
    );
  if (!wait) return usable ?? null;
  return inflight.get(key)!;
}

async function fetchBook(
  c: Contrack,
  owner: string | null,
  token: string,
  hit: Book | undefined,
  now: number,
): Promise<Book> {
  const key = owner ?? '';
  const book = owner === null ? 'company' : 'mine';
  try {
    const rows = await ctk<Slim[]>(c.url, token, 'api/contacts?view=slim');
    const fresh = { contacts: rows.map((r) => toDto(c, r, book)), at: now, error: null, token };
    cache.set(key, fresh);
    return fresh;
  } catch (err) {
    const stale = {
      contacts: hit?.contacts ?? [],
      at: now, // tried now: the next try is in 5 minutes, not on every lookup
      error: (err as Error).message,
      token,
    };
    cache.set(key, stale);
    return stale;
  }
}

/** Writing to a book whose owner hasn't connected Contrack. */
export const needToken = (owner: string | null) =>
  new ContrackError(
    owner
      ? 'Connect your Contrack account first (My settings → Contacts)'
      : 'The company Contrack account has no token (Settings → Contacts)',
    409,
  );

/** Adds a contact to a Contrack book (11 §4.3: "Add to contacts", an accepted share). */
export async function contrackCreate(
  db: Db,
  c: Contrack,
  owner: string | null,
  d: ContactData,
): Promise<ContactDto> {
  const token = await tokenFor(db, c, owner);
  if (!token) throw needToken(owner);
  const row = await ctk<Slim>(c.url, token, 'api/contacts', {
    method: 'POST',
    body: JSON.stringify({
      name: d.name,
      ...(d.company ? { company: d.company } : {}),
      ...(d.email ? { emails: [{ email: d.email }] } : {}),
      phones: d.numbers.map((n) => ({ phone: n.number, ...(n.label ? { label: n.label } : {}) })),
    }),
  });
  forgetBook(owner);
  return toDto(c, row, owner === null ? 'company' : 'mine');
}

/** A timeline entry on a contact (11 §4.4); answers its id. */
export async function contrackInteraction(
  c: Contrack,
  token: string,
  contactId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const r = await ctk<{ id: string }>(
    c.url,
    token,
    `api/contacts/${encodeURIComponent(contactId)}/interactions`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return r.id;
}

/** Settings → Contacts → Test, and connecting a token: reachable, and the token reads contacts. */
export async function contrackCheck(url: string, token: string | null): Promise<string> {
  try {
    assertLocalUrl(url);
  } catch (err) {
    throw new ContrackError((err as AiError).message);
  }
  const health = await fetch(new URL('healthz', url.endsWith('/') ? url : `${url}/`), {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!health?.ok) throw new ContrackError(`Can't reach Contrack at ${url}`);
  if (!token) return 'Contrack answers.';
  const rows = await ctk<Slim[]>(url, token, 'api/contacts?view=slim');
  return `Contrack answers; the token reads ${rows.length} contact${rows.length === 1 ? '' : 's'}.`;
}
