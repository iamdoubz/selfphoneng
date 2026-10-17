// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/auth/* (04 §2, §7.3).
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ChangePasswordSchema, LoginSchema, type AuthUser } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { extensions, users } from '../db/schema.ts';
import { unauthorized, rateLimited, badRequest } from '../errors.ts';
import { audit } from '../services/audit.ts';
import { requireAuth, type CurrentUser } from '../auth/guards.ts';
import { isLoginBlocked, recordLoginFailure } from '../auth/login-limiter.ts';
import {
  assertPasswordPolicy,
  burnVerify,
  hashPassword,
  verifyPassword,
} from '../auth/passwords.ts';
import {
  COOKIE,
  clearSessionCookie,
  createSession,
  deleteSession,
  deleteUserSessions,
  setSessionCookie,
} from '../auth/sessions.ts';

export async function toAuthUser(db: Db, u: CurrentUser): Promise<AuthUser> {
  const [ext] = await db
    .select({ id: extensions.id, number: extensions.number, name: extensions.name })
    .from(extensions)
    .where(eq(extensions.userId, u.id));
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
    extension: ext ?? null,
  };
}

export async function authRoutes(app: FastifyInstance) {
  const { db } = app;

  app.post('/api/auth/login', async (req, reply) => {
    const body = LoginSchema.parse(req.body);
    if (isLoginBlocked(req.ip, body.email)) throw rateLimited();
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    const ok = user?.isActive
      ? await verifyPassword(user.passwordHash, body.password)
      : (await burnVerify(body.password), false);
    if (!user || !ok) {
      recordLoginFailure(req.ip, body.email);
      req.log.warn({ event: 'auth.failed', ip: req.ip }, 'login failed');
      await audit(db, {
        actorUserId: user?.id,
        actorIp: req.ip,
        action: 'login_failed',
        entityType: 'user',
        entityId: user?.id,
        summary: `Failed login for ${body.email}`,
      });
      throw unauthorized('Wrong email or password');
    }
    const token = await createSession(db, user.id, req.ip, req.headers['user-agent'] ?? null);
    setSessionCookie(reply, token);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await audit(db, {
      actorUserId: user.id,
      actorIp: req.ip,
      action: 'login',
      entityType: 'user',
      entityId: user.id,
      summary: `${user.email} logged in`,
    });
    return { user: await toAuthUser(db, user) };
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    await deleteSession(db, req.cookies[COOKIE]!);
    clearSessionCookie(reply);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'logout',
      entityType: 'user',
      entityId: req.user!.id,
      summary: `${req.user!.email} logged out`,
    });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => ({
    user: await toAuthUser(db, req.user!),
  }));

  app.post('/api/auth/change-password', { preHandler: requireAuth }, async (req) => {
    const body = ChangePasswordSchema.parse(req.body);
    const user = req.user!;
    if (!(await verifyPassword(user.passwordHash, body.currentPassword)))
      throw badRequest('Current password is wrong');
    if (body.newPassword === body.currentPassword)
      throw badRequest('Choose a password different from the current one');
    assertPasswordPolicy(body.newPassword);
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), mustChangePassword: false })
      .where(eq(users.id, user.id));
    await deleteUserSessions(db, user.id, req.sessionId!);
    await audit(db, {
      actorUserId: user.id,
      actorIp: req.ip,
      action: 'password_changed',
      entityType: 'user',
      entityId: user.id,
      summary: `${user.email} changed their password`,
    });
    return { ok: true };
  });
}
