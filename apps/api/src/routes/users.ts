// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/users (04 §7.3). Admin only.
import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  UserCreateSchema,
  UserUpdateSchema,
  type ListResponse,
  type UserDto,
} from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { extensions, users } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { requireAdmin } from '../auth/guards.ts';
import { hashPassword } from '../auth/passwords.ts';
import { deleteUserSessions } from '../auth/sessions.ts';
import { randomAlnum } from '../crypto/secrets.ts';
import { audit } from '../services/audit.ts';

type UserRow = typeof users.$inferSelect;

export const toUserDto = (u: UserRow, extension: UserDto['extension'] = null): UserDto => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  role: u.role,
  isActive: u.isActive,
  mustChangePassword: u.mustChangePassword,
  twoStep: u.totpSecretEnc !== null,
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  createdAt: u.createdAt.toISOString(),
  extension,
});

const extOf = async (db: Db, userId: string) => {
  const [e] = await db
    .select({ id: extensions.id, number: extensions.number })
    .from(extensions)
    .where(eq(extensions.userId, userId));
  return e ?? null;
};

const IdParams = z.object({ id: z.uuid() });

/** 16 random letters/digits: never in the common list, and the user must change it at first login. */
const temporaryPassword = () => randomAlnum(16);

const isUniqueViolation = (e: unknown) =>
  (e as { code?: string; cause?: { code?: string } }).code === '23505' ||
  (e as { cause?: { code?: string } }).cause?.code === '23505';

async function getUser(db: Db, id: string): Promise<UserRow> {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) throw notFound('User not found');
  return u;
}

/** Throws if removing `id` from the active admins would leave none. */
async function assertNotLastAdmin(db: Db, id: string) {
  const [r] = await db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isActive, true), ne(users.id, id)));
  if (!r || r.n === 0) throw conflict('This is the last active admin');
}

export async function userRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  // ponytail: one page with every user (v1 targets ≤100 users); cursor paging when it's needed.
  app.get('/api/users', async (): Promise<ListResponse<UserDto>> => {
    const rows = await db
      .select({ u: users, extId: extensions.id, extNumber: extensions.number })
      .from(users)
      .leftJoin(extensions, eq(extensions.userId, users.id))
      .orderBy(asc(users.displayName), asc(users.id));
    return {
      items: rows.map((r) =>
        toUserDto(r.u, r.extId && r.extNumber ? { id: r.extId, number: r.extNumber } : null),
      ),
      nextCursor: null,
    };
  });

  app.get('/api/users/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return toUserDto(await getUser(db, id), await extOf(db, id));
  });

  app.post('/api/users', async (req, reply) => {
    const body = UserCreateSchema.parse(req.body);
    const password = temporaryPassword();
    let created: UserRow;
    try {
      [created] = (await db
        .insert(users)
        .values({ ...body, passwordHash: await hashPassword(password), mustChangePassword: true })
        .returning()) as [UserRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('A user with this email already exists');
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'user',
      entityId: created.id,
      summary: `Created user ${created.email}`,
      diff: { after: body },
    });
    // The temporary password is shown once and never stored in plain text.
    return reply.code(201).send({ user: toUserDto(created), temporaryPassword: password });
  });

  app.patch('/api/users/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = UserUpdateSchema.parse(req.body);
    if (Object.keys(body).length === 0) throw badRequest('Nothing to update');
    const before = await getUser(db, id);
    const losesAdmin =
      before.role === 'admin' &&
      before.isActive &&
      (body.role === 'user' || body.isActive === false);
    if (losesAdmin) await assertNotLastAdmin(db, id);

    let after: UserRow;
    try {
      [after] = (await db.update(users).set(body).where(eq(users.id, id)).returning()) as [UserRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('A user with this email already exists');
      throw e;
    }
    if (body.isActive === false) await deleteUserSessions(db, id);

    const changed = Object.keys(body).filter(
      (k) => before[k as keyof UserRow] !== after[k as keyof UserRow],
    ) as (keyof typeof body)[];
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'user',
      entityId: id,
      summary: `Updated user ${after.email}${changed.length ? ` (${changed.join(', ')})` : ''}`,
      diff: {
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, after[k]])),
      },
    });
    return toUserDto(after, await extOf(db, id));
  });

  app.delete('/api/users/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    if (id === req.user!.id) throw conflict('You cannot delete your own account');
    const u = await getUser(db, id);
    if (u.role === 'admin' && u.isActive) await assertNotLastAdmin(db, id);
    await db.delete(users).where(eq(users.id, id)); // sessions cascade; extensions.user_id → null
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'user',
      entityId: id,
      summary: `Deleted user ${u.email}`,
      diff: { before: toUserDto(u) },
    });
    return { ok: true };
  });

  app.post('/api/users/:id/reset-password', async (req) => {
    const { id } = IdParams.parse(req.params);
    const u = await getUser(db, id);
    const password = temporaryPassword();
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password), mustChangePassword: true })
      .where(eq(users.id, id));
    await deleteUserSessions(db, id);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'reset_password',
      entityType: 'user',
      entityId: id,
      summary: `Reset the password of ${u.email}`,
    });
    return { temporaryPassword: password };
  });

  /** For an admin who lost their phone and their recovery codes: another admin turns it off. */
  app.post('/api/users/:id/reset-two-step', async (req) => {
    const { id } = IdParams.parse(req.params);
    const u = await getUser(db, id);
    await db
      .update(users)
      .set({ totpSecretEnc: null, totpLastStep: null, totpRecoveryHashes: [] })
      .where(eq(users.id, id));
    await deleteUserSessions(db, id);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'totp_disabled',
      entityType: 'user',
      entityId: id,
      summary: `Turned off two-step sign-in for ${u.email}`,
    });
    return { ok: true };
  });
}
