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
  type ContactData,
  type ContactDto,
  type ContactImportResult,
  type ContactShareDto,
  type ListResponse,
} from '@selfphoneng/shared';
import { requireAdmin, requireAuth } from '../auth/guards.ts';
import {
  addToBook,
  cleanNumbers,
  listBook,
  listBooks,
  toDto,
  type Owner,
} from '../contacts/book.ts';
import { parseCsv } from '../contacts/csv.ts';
import { parseVcards } from '../contacts/vcard.ts';
import { contactShares, contacts, extensions, users } from '../db/schema.ts';
import { badRequest, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';

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
      const [row] = await db
        .insert(contacts)
        .values({ ...c, numbers: cleanNumbers(c), ownerUserId: ownerOf(req.user!) })
        .returning();
      await log(req, 'create', row!.id, `Added ${c.name} to the company contacts`);
      return reply.code(201).send(toDto(row!));
    });

    app.patch(`${prefix}/:id`, { preHandler: guard }, async (req): Promise<ContactDto> => {
      const { id } = IdParams.parse(req.params);
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
      const r = await mine(req.user!, id);
      await db.delete(contacts).where(eq(contacts.id, id));
      await log(req, 'delete', id, `Deleted the company contact ${r.name}`);
      return { ok: true };
    });

    app.post(
      `${prefix}/import`,
      { preHandler: guard, bodyLimit: IMPORT_BODY },
      async (req): Promise<ContactImportResult> => {
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
  app.get(
    '/api/me/contacts',
    { preHandler: requireAuth },
    async (req): Promise<ListResponse<ContactDto>> => ({
      items: await listBooks(db, req.user!.id),
      nextCursor: null,
    }),
  );
  book('/api/me/contacts', requireAuth, (u) => u.id);

  // ───── the company book ─────
  app.get(
    '/api/contacts',
    { preHandler: requireAdmin },
    async (): Promise<ListResponse<ContactDto>> => ({
      items: await listBook(db, null),
      nextCursor: null,
    }),
  );
  book('/api/contacts', requireAdmin, () => null);

  // ───── sharing: an offer each, accepted or denied by the recipient (11 §2.1) ─────
  app.post('/api/me/contacts/share', { preHandler: requireAuth }, async (req) => {
    const s = ContactShareSchema.parse(req.body);
    const me = req.user!.id;
    const picked = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.ownerUserId, me), inArray(contacts.id, s.contactIds)));
    if (picked.length !== s.contactIds.length) throw notFound('Contact not found');
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
          picked.map((c) => {
            const { id: _i, book: _b, ...contact } = toDto(c);
            return { fromUserId: me, toUserId: u.id, sourceId: c.id, contact };
          }),
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
      return db.transaction(async (tx) => {
        const offers = await tx
          .update(contactShares)
          .set({ status: decision === 'accept' ? 'accepted' : 'denied', decidedAt: new Date() })
          .where(
            and(
              eq(contactShares.toUserId, me),
              eq(contactShares.status, 'pending'),
              inArray(contactShares.id, ids),
            ),
          )
          .returning();
        if (decision === 'deny') return { denied: offers.length };
        const r = await addToBook(
          tx,
          me,
          offers.map((o) => o.contact as ContactData),
          true,
        );
        return { added: r.added, duplicates: r.duplicates };
      });
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
