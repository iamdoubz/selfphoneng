// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/me/contacts (my book, shares) and /api/contacts (the company book, admin): spec 11.
import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ContactImportSchema,
  ContactInputSchema,
  ContactShareDecisionSchema,
  ContactShareSchema,
  type ContactBookDto,
  type ContactData,
  type ContactDto,
  type ContactImportResult,
  type ContactShareDto,
  type ListResponse,
} from '@selfphoneng/shared';
import { requireAdmin, requireAuth } from '../auth/guards.ts';
import {
  addToBook,
  assertBuiltin,
  cleanNumbers,
  contactNames,
  createContact,
  readBooks,
  toDto,
  type Owner,
} from '../contacts/book.ts';
import { parseCsv } from '../contacts/csv.ts';
import { parseVcards } from '../contacts/vcard.ts';
import { contactShares, contacts, extensions, users } from '../db/schema.ts';
import { badRequest, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';
import { getSetting } from '../services/settings.ts';
import { decrypt } from '../crypto/secrets.ts';
import { contrackCheck } from '../contacts/contrack.ts';
import { callerNameToken, phoneSafeName, sameToken } from '../contacts/callername.ts';

const IdParams = z.object({ id: z.uuid() });
const CommitQuery = z.object({ commit: z.enum(['0', '1']).default('0') });
/** 5,000 contacts or 5 MB of files per import (11 §3.1). */
const MAX_IMPORT = 5000;
const IMPORT_BODY = 6 * 1024 * 1024;

/** Every contact in the files, and what couldn't be read. */
function readFiles(files: { name: string; text: string }[]) {
  const list: ContactData[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const vcf = /\.vcf$/i.test(f.name) || /^\s*BEGIN:VCARD/i.test(f.text);
    const r = vcf ? parseVcards(f.text) : parseCsv(f.text);
    list.push(...r.contacts);
    errors.push(...r.errors.map((e) => `${f.name}: ${e}`));
  }
  if (list.length > MAX_IMPORT) throw badRequest(`At most ${MAX_IMPORT} contacts per import`);
  return { list, errors };
}

export async function contactRoutes(app: FastifyInstance) {
  const { db } = app;

  // ───── the routes both books have; `owner` says whose ─────
  const book = (
    prefix: string,
    guard: typeof requireAuth,
    ownerOf: (u: { id: string }) => Owner,
  ) => {
    const mine = (u: { id: string }, id: string) =>
      db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.id, id),
            ownerOf(u) ? eq(contacts.ownerUserId, ownerOf(u)!) : isNull(contacts.ownerUserId),
          ),
        )
        .then(([r]) => {
          if (!r) throw notFound('Contact not found');
          return r;
        });
    const company = (u: { id: string }) => ownerOf(u) === null;
    const log = (
      req: { user: { id: string } | null; ip: string },
      action: 'create' | 'update' | 'delete',
      id: string | undefined,
      summary: string,
    ) =>
      company(req.user!)
        ? audit(db, {
            actorUserId: req.user!.id,
            actorIp: req.ip,
            action,
            entityType: 'contact',
            entityId: id,
            summary,
          })
        : undefined;

    app.post(prefix, { preHandler: guard }, async (req, reply) => {
      const c = ContactInputSchema.parse(req.body);
      const dto = await createContact(db, ownerOf(req.user!), c);
      await log(req, 'create', dto.id, `Added ${c.name} to the company contacts`);
      return reply.code(201).send(dto);
    });

    app.patch(`${prefix}/:id`, { preHandler: guard }, async (req): Promise<ContactDto> => {
      const { id } = IdParams.parse(req.params);
      await assertBuiltin(db);
      await mine(req.user!, id);
      const c = ContactInputSchema.parse(req.body);
      const [row] = await db
        .update(contacts)
        .set({ ...c, numbers: cleanNumbers(c), updatedAt: new Date() })
        .where(eq(contacts.id, id))
        .returning();
      await log(req, 'update', id, `Changed the company contact ${c.name}`);
      return toDto(row!);
    });

    app.delete(`${prefix}/:id`, { preHandler: guard }, async (req) => {
      const { id } = IdParams.parse(req.params);
      await assertBuiltin(db);
      const r = await mine(req.user!, id);
      await db.delete(contacts).where(eq(contacts.id, id));
      await log(req, 'delete', id, `Deleted the company contact ${r.name}`);
      return { ok: true };
    });

    app.post(
      `${prefix}/import`,
      { preHandler: guard, bodyLimit: IMPORT_BODY },
      async (req): Promise<ContactImportResult> => {
        await assertBuiltin(db); // Contrack has its own importer (11 §3.1)
        const { files } = ContactImportSchema.parse(req.body);
        const commit = CommitQuery.parse(req.query).commit === '1';
        const { list, errors } = readFiles(files);
        const r = await addToBook(db, ownerOf(req.user!), list, commit, errors);
        if (commit && r.added)
          await log(req, 'create', undefined, `Imported ${r.added} company contacts`);
        return r;
      },
    );
  };

  // ───── my book ─────
  /** Mine and the company's: the page filters, and the browser looks up names from it. */
  app.get('/api/me/contacts', { preHandler: requireAuth }, async (req): Promise<ContactBookDto> =>
    readBooks(db, req.user!.id),
  );
  book('/api/me/contacts', requireAuth, (u) => u.id);

  // ───── the company book ─────
  app.get('/api/contacts', { preHandler: requireAdmin }, async (): Promise<ContactBookDto> =>
    readBooks(db, null),
  );
  book('/api/contacts', requireAdmin, () => null);

  /**
   * The dialplan's caller-name lookup (11 §6 C4): only Asterisk on this machine (no proxy in
   * between) with the token. Never waits on Contrack. Not logged: the token is in the query.
   */
  app.get('/api/internal/caller-name', { logLevel: 'silent' }, async (req, reply) => {
    const q = z
      .object({
        ext: z.string().regex(/^\d{1,10}$/),
        number: z.string().regex(/^\d{3,20}$/),
        token: z.string().max(100),
      })
      .safeParse(req.query);
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
    if (
      !local ||
      req.headers['x-forwarded-for'] ||
      !q.success ||
      !sameToken(q.data.token, callerNameToken(app.config.APP_SECRET))
    )
      return reply.code(404).send('');
    const [e] = await db
      .select({ userId: extensions.userId })
      .from(extensions)
      .where(eq(extensions.number, q.data.ext));
    const names = await contactNames(db, e?.userId ?? null, [q.data.number], { wait: false }).catch(
      () => new Map<string, string>(),
    );
    return reply
      .type('text/plain; charset=utf-8')
      .send(phoneSafeName(names.get(q.data.number) ?? ''));
  });

  /** Settings → Contacts → Test (11 §4.3): the form's address, and its token or the saved one. */
  app.post('/api/contacts/contrack/test', { preHandler: requireAdmin }, async (req) => {
    const b = z
      .object({ url: z.string().trim().min(1), companyToken: z.string().trim().optional() })
      .parse(req.body);
    const saved = await getSetting(db, 'contacts.contrack');
    const token =
      b.companyToken || (saved?.companyTokenEnc ? decrypt(saved.companyTokenEnc) : null);
    try {
      return { ok: true, detail: await contrackCheck(b.url, token) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ───── sharing: an offer each, accepted or denied by the recipient (11 §2.1) ─────
  app.post('/api/me/contacts/share', { preHandler: requireAuth }, async (req) => {
    const s = ContactShareSchema.parse(req.body);
    const me = req.user!.id;
    const picked = (await readBooks(db, me)).items.filter(
      (c) => c.book === 'mine' && s.contactIds.includes(c.id),
    );
    if (picked.length !== new Set(s.contactIds).size) throw notFound('Contact not found');
    const to = s.everyone
      ? await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.isActive, true), ne(users.id, me)))
      : await db
          .select({ id: users.id })
          .from(extensions)
          .innerJoin(users, eq(users.id, extensions.userId))
          .where(
            and(
              inArray(extensions.number, s.extensions),
              eq(users.isActive, true),
              ne(users.id, me),
            ),
          );
    if (!to.length) throw badRequest('Nobody to share with');
    await db.transaction(async (tx) => {
      // The same contact offered again replaces the pending offer.
      await tx.delete(contactShares).where(
        and(
          eq(contactShares.status, 'pending'),
          inArray(
            contactShares.toUserId,
            to.map((u) => u.id),
          ),
          inArray(
            contactShares.sourceId,
            picked.map((c) => c.id),
          ),
        ),
      );
      await tx.insert(contactShares).values(
        to.flatMap((u) =>
          picked.map(({ id, name, company, email, numbers, notes }) => ({
            fromUserId: me,
            toUserId: u.id,
            sourceId: id,
            contact: { name, company, email, numbers, notes },
          })),
        ),
      );
    });
    return { offers: picked.length * to.length, people: to.length };
  });

  app.get(
    '/api/me/contacts/shares',
    { preHandler: requireAuth },
    async (req): Promise<ListResponse<ContactShareDto>> => {
      const rows = await db
        .select({ s: contactShares, fromName: users.displayName })
        .from(contactShares)
        .leftJoin(users, eq(users.id, contactShares.fromUserId))
        .where(and(eq(contactShares.toUserId, req.user!.id), eq(contactShares.status, 'pending')))
        .orderBy(desc(contactShares.createdAt));
      return {
        items: rows.map(({ s, fromName }) => ({
          id: s.id,
          from: s.fromUserId && fromName ? { userId: s.fromUserId, name: fromName } : null,
          contact: s.contact as ContactData,
          createdAt: s.createdAt.toISOString(),
        })),
        nextCursor: null,
      };
    },
  );

  for (const decision of ['accept', 'deny'] as const)
    app.post(`/api/me/contacts/shares/${decision}`, { preHandler: requireAuth }, async (req) => {
      const { ids } = ContactShareDecisionSchema.parse(req.body);
      const me = req.user!.id;
      const mineAndPending = and(
        eq(contactShares.toUserId, me),
        eq(contactShares.status, 'pending'),
        inArray(contactShares.id, ids),
      );
      const offers = await db.select().from(contactShares).where(mineAndPending);
      // Added first, then marked: Contrack being down (or not connected) leaves the offers waiting.
      const r =
        decision === 'accept'
          ? await addToBook(
              db,
              me,
              offers.map((o) => o.contact as ContactData),
              true,
            )
          : null;
      await db
        .update(contactShares)
        .set({ status: decision === 'accept' ? 'accepted' : 'denied', decidedAt: new Date() })
        .where(
          and(
            mineAndPending,
            inArray(
              contactShares.id,
              offers.map((o) => o.id),
            ),
          ),
        );
      return r ? { added: r.added, duplicates: r.duplicates } : { denied: offers.length };
    });
}

/** Decided offers go after 30 days (11 §2.1); retentionCleanup calls it. */
export const cleanupContactShares = (db: FastifyInstance['db']) =>
  db
    .delete(contactShares)
    .where(
      and(
        ne(contactShares.status, 'pending'),
        lt(contactShares.decidedAt, sql`now() - interval '30 days'`),
      ),
    );
