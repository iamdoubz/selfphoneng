// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/users (04 §7.3). Admin only.
import { and, asc, count, eq, isNotNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  UserCreateSchema,
  UserUpdateSchema,
  type ListResponse,
  type UserDto,
} from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { extensions, userIdentities, users } from '../db/schema.ts';
import { HttpError, badRequest, conflict, notFound } from '../errors.ts';
import { requireAdmin } from '../auth/guards.ts';
import { hashPassword } from '../auth/passwords.ts';
import { deleteUserSessions } from '../auth/sessions.ts';
import { randomAlnum } from '../crypto/secrets.ts';
import { audit } from '../services/audit.ts';
import { getSetting } from '../services/settings.ts';
import { signInWays } from './auth.ts';

type UserRow = typeof users.$inferSelect;
type IdentityRow = {
  userId: string;
  kind: 'oidc' | 'ldap';
  email: string | null;
  groups: string[];
};

export const toUserDto = (
  u: UserRow,
  extension: UserDto['extension'] = null,
  ids: IdentityRow[] = [],
  from: RoleSources = { oidc: null, ldap: false },
): UserDto => ({
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
  signIn: signInWays(u, ids),
  roleFrom: roleFrom(ids, from),
});

/** The providers that set roles now (12 §1): adminGroups / adminFilter set and in use. */
type RoleSources = { oidc: string | null; ldap: boolean };
async function roleSources(db: Db): Promise<RoleSources> {
  const [oidc, ldap, mode] = await Promise.all([
    getSetting(db, 'auth.oidc'),
    getSetting(db, 'auth.ldap'),
    getSetting(db, 'auth.mode'),
  ]);
  return {
    oidc: oidc && mode !== 'password' && oidc.adminGroups.length > 0 ? oidc.label : null,
    ldap: Boolean(ldap?.enabled && ldap.adminFilter),
  };
}
const roleFrom = (ids: { kind: string }[], from: RoleSources) =>
  (from.oidc && ids.some((i) => i.kind === 'oidc') && from.oidc) ||
  (from.ldap && ids.some((i) => i.kind === 'ldap') ? 'the directory' : null);

/** Connected accounts (12 §2), for one user or all of them. */
const identitiesOf = (db: Db, userId?: string): Promise<IdentityRow[]> =>
  db
    .select({
      userId: userIdentities.userId,
      kind: userIdentities.kind,
      email: userIdentities.email,
      groups: userIdentities.groups,
    })
    .from(userIdentities)
    .where(userId ? eq(userIdentities.userId, userId) : undefined);

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

/**
 * Removing `id` from the active admins would leave none with a password: the way in when the
 * identity provider is down (12 §1).
 */
export async function isLastAdmin(db: Db, id: string): Promise<boolean> {
  const [r] = await db
    .select({ n: count() })
    .from(users)
    .where(
      and(
        eq(users.role, 'admin'),
        eq(users.isActive, true),
        isNotNull(users.passwordHash),
        ne(users.id, id),
      ),
    );
  return !r || r.n === 0;
}

async function assertNotLastAdmin(db: Db, id: string) {
  if (await isLastAdmin(db, id)) throw conflict('This is the last active admin with a password');
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
    const ids = await identitiesOf(db);
    const from = await roleSources(db);
    return {
      items: rows.map((r) =>
        toUserDto(
          r.u,
          r.extId && r.extNumber ? { id: r.extId, number: r.extNumber } : null,
          ids.filter((i) => i.userId === r.u.id),
          from,
        ),
      ),
      nextCursor: null,
    };
  });

  app.get('/api/users/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return toUserDto(
      await getUser(db, id),
      await extOf(db, id),
      await identitiesOf(db, id),
      await roleSources(db),
    );
  });

  app.post('/api/users', async (req, reply) => {
    const body = UserCreateSchema.parse(req.body);
    // OpenID only (12 §3.3): no password; their first sign-in matches them by verified email.
    const password = (await getSetting(db, 'auth.mode')) === 'oidc' ? null : temporaryPassword();
    let created: UserRow;
    try {
      [created] = (await db
        .insert(users)
        .values({
          ...body,
          passwordHash: password && (await hashPassword(password)),
          mustChangePassword: password !== null,
        })
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
    const ids = await identitiesOf(db, id);
    const from = await roleSources(db);
    // 12 §1: a provider that sets the role would undo this at the next sign-in or check.
    const managed = roleFrom(ids, from);
    if (body.role !== undefined && body.role !== before.role && managed)
      throw new HttpError(409, 'role_managed', `The role comes from ${managed}`);
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
    return toUserDto(after, await extOf(db, id), ids, from);
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
