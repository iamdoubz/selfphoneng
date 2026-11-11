// SPDX-License-Identifier: AGPL-3.0-or-later
// Photos (11 §8): my own, any user's (admins), and builtin contacts' (mine, or the company's for
// admins). The body is the image itself, which the browser already made a 256 px JPEG. In Contrack
// mode contact photos stay in Contrack: /api/photos/contrack/* fetches one with the book's token.
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PHOTO_MAX_BYTES, PHOTO_TYPES, photoType } from '@selfphoneng/shared';
import { requireAdmin, requireAuth } from '../auth/guards.ts';
import { CONTRACK_PHOTO, contrackPhoto, contrackSettings } from '../contacts/contrack.ts';
import { assertBuiltin } from '../contacts/book.ts';
import type { Db } from '../db/client.ts';
import { contacts, photos, users } from '../db/schema.ts';
import { badRequest, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';

const IdParams = z.object({ id: z.uuid() });

type Owner = { userId: string } | { contactId: string };
/** A user's photo id (11 §8), or null. */
export const photoIdOf = (db: Db, userId: string) =>
  db
    .select({ id: photos.id })
    .from(photos)
    .where(eq(photos.userId, userId))
    .then(([p]) => p?.id ?? null);

/** Stores (or replaces, with a new id) one photo. */
async function save(db: Db, owner: Owner, body: unknown): Promise<{ id: string }> {
  if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Send the photo as the body');
  const mime = photoType(body);
  if (!mime) throw badRequest('Photos must be JPEG, PNG or WebP');
  const target = 'userId' in owner ? photos.userId : photos.contactId;
  const [row] = await db
    .insert(photos)
    .values({ ...owner, mime, data: body })
    .onConflictDoUpdate({
      target,
      set: { id: sql`gen_random_uuid()`, mime, data: body, updatedAt: new Date() },
    })
    .returning({ id: photos.id });
  return row!;
}

const remove = (db: Db, owner: Owner) =>
  db
    .delete(photos)
    .where(
      'userId' in owner ? eq(photos.userId, owner.userId) : eq(photos.contactId, owner.contactId),
    );

function sendImage(reply: FastifyReply, mime: string, data: Buffer, maxAge: string) {
  return reply.header('Cache-Control', `private, ${maxAge}`).type(mime).send(data);
}

export async function photoRoutes(app: FastifyInstance) {
  const { db } = app;
  // Over the limit: 413 before the rest is read. Other types aren't parsed at all (415).
  app.addContentTypeParser(
    [...PHOTO_TYPES],
    { parseAs: 'buffer', bodyLimit: PHOTO_MAX_BYTES },
    (_r, b, done) => done(null, b),
  );
  const userChanged = () => app.live.loadFromDb(); // presence shows extensions' photos

  app.get('/api/photos/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const me = req.user!.id;
    // People's photos: anyone signed in (presence shows them). Contacts': the book's readers.
    const [p] = await db
      .select({ mime: photos.mime, data: photos.data })
      .from(photos)
      .leftJoin(contacts, eq(contacts.id, photos.contactId))
      .where(
        and(
          eq(photos.id, id),
          or(isNull(photos.contactId), isNull(contacts.ownerUserId), eq(contacts.ownerUserId, me)),
        ),
      );
    if (!p) throw notFound('Photo not found');
    return sendImage(reply, p.mime, p.data, 'max-age=31536000, immutable');
  });

  // Contrack keeps uploaded photos at /uploads/u/<owner>/avatars/<file>, for that owner's token.
  const ContrackQuery = z.object({ p: z.string().regex(CONTRACK_PHOTO) });
  app.get('/api/photos/contrack/:book', { preHandler: requireAuth }, async (req, reply) => {
    const { book } = z.object({ book: z.enum(['mine', 'company']) }).parse(req.params);
    const { p } = ContrackQuery.parse(req.query);
    const c = await contrackSettings(db);
    if (!c) throw notFound('Photo not found');
    const img = await contrackPhoto(db, c, book === 'mine' ? req.user!.id : null, p);
    if (!img) throw notFound('Photo not found');
    return sendImage(reply, img.mime, img.data, 'max-age=86400');
  });

  app.put('/api/me/photo', { preHandler: requireAuth }, async (req) => {
    const r = await save(db, { userId: req.user!.id }, req.body);
    await userChanged();
    return r;
  });
  app.delete('/api/me/photo', { preHandler: requireAuth }, async (req) => {
    await remove(db, { userId: req.user!.id });
    await userChanged();
    return { ok: true };
  });

  const ofUser = async (id: string) => {
    const [u] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, id));
    if (!u) throw notFound('User not found');
    return u;
  };
  app.put('/api/users/:id/photo', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const u = await ofUser(id);
    const r = await save(db, { userId: id }, req.body);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'user',
      entityId: id,
      summary: `Changed ${u.name}'s photo`,
    });
    await userChanged();
    return r;
  });
  app.delete('/api/users/:id/photo', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const u = await ofUser(id);
    await remove(db, { userId: id });
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'user',
      entityId: id,
      summary: `Removed ${u.name}'s photo`,
    });
    await userChanged();
    return { ok: true };
  });

  // Builtin contacts: my book's, or the company's (admins). Contrack's change in Contrack.
  for (const [prefix, guard, company] of [
    ['/api/me/contacts', requireAuth, false],
    ['/api/contacts', requireAdmin, true],
  ] as const) {
    const contact = async (userId: string, id: string) => {
      await assertBuiltin(db);
      const [c] = await db
        .select({ name: contacts.name })
        .from(contacts)
        .where(
          and(
            eq(contacts.id, id),
            company ? isNull(contacts.ownerUserId) : eq(contacts.ownerUserId, userId),
          ),
        );
      if (!c) throw notFound('Contact not found');
      return c;
    };
    const log = (req: { user: { id: string } | null; ip: string }, id: string, summary: string) =>
      company
        ? audit(db, {
            actorUserId: req.user!.id,
            actorIp: req.ip,
            action: 'update',
            entityType: 'contact',
            entityId: id,
            summary,
          })
        : undefined;
    app.put(`${prefix}/:id/photo`, { preHandler: guard }, async (req) => {
      const { id } = IdParams.parse(req.params);
      const c = await contact(req.user!.id, id);
      const r = await save(db, { contactId: id }, req.body);
      await log(req, id, `Changed the company contact ${c.name}'s photo`);
      return r;
    });
    app.delete(`${prefix}/:id/photo`, { preHandler: guard }, async (req) => {
      const { id } = IdParams.parse(req.params);
      const c = await contact(req.user!.id, id);
      await remove(db, { contactId: id });
      await log(req, id, `Removed the company contact ${c.name}'s photo`);
      return { ok: true };
    });
  }
}
