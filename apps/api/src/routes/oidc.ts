// SPDX-License-Identifier: AGPL-3.0-or-later
// Sign in with OpenID Connect, connect and disconnect an OpenID account (12 §3.2, §3.3).
import { and, eq, gt, isNull, notExists } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decrypt, encrypt } from '../crypto/secrets.ts';
import { sessions, userIdentities, users } from '../db/schema.ts';
import { HttpError, notFound, unauthorized } from '../errors.ts';
import { requireAdmin, requireAuth } from '../auth/guards.ts';
import { isLoginBlocked, recordLoginFailure } from '../auth/login-limiter.ts';
import { createSession, setSessionCookie } from '../auth/sessions.ts';
import { audit } from '../services/audit.ts';
import { getSetting } from '../services/settings.ts';
import { decide, verifiedEmail } from '../sso/claims.ts';
import { applyClaims } from '../sso/oidcCheck.ts';
import {
  finishSignIn,
  oidcError,
  startSignIn,
  type OidcSettings,
  type PendingSignIn,
} from '../sso/oidc.ts';

export const OIDC_COOKIE = 'sp_oidc';
const COOKIE_PATH = '/api/auth/oidc';

/** Same-site paths only: never send the browser to another origin. */
const safeNext = (p: string | undefined) => (p && /^\/(?![/\\])/.test(p) ? p : undefined);

const withParam = (path: string, k: string, v: string) =>
  `${path}${path.includes('?') ? '&' : '?'}${k}=${v}`;

export async function oidcRoutes(app: FastifyInstance) {
  const { db } = app;
  const host = app.config.PUBLIC_HOSTNAME;

  /** The provider's settings, when OpenID is on (12 §1.1: not in `password` mode). */
  async function enabled(): Promise<OidcSettings> {
    const s = await getSetting(db, 'auth.oidc');
    if (!s || (await getSetting(db, 'auth.mode')) === 'password') throw notFound();
    return s;
  }

  app.get('/api/auth/oidc/start', async (req, reply) => {
    const s = await enabled();
    const q = z
      .object({ next: z.string().max(500).optional(), connect: z.literal('1').optional() })
      .parse(req.query);
    let connectSessionId: string | null = null;
    let next = safeNext(q.next);
    if (q.connect) {
      await requireAuth(req, reply);
      if (!req.sessionId) throw unauthorized(); // an API token can't connect an account
      connectSessionId = req.sessionId;
      next ??= req.user!.role === 'admin' ? '/admin/account' : '/me/settings';
    }
    try {
      const { url, pending } = await startSignIn(s, host, next ?? '/', connectSessionId);
      reply.setCookie(OIDC_COOKIE, encrypt(JSON.stringify(pending)), {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: COOKIE_PATH,
        maxAge: 600,
      });
      return reply.redirect(url.href);
    } catch (err) {
      req.log.warn({ event: 'auth.oidc', err: oidcError(err) }, 'OpenID discovery failed');
      return reply.redirect(
        withParam(connectSessionId ? next! : '/login', 'sso_error', 'provider'),
      );
    }
  });

  // Not logged by Fastify: the query holds the authorization code (12 §1).
  app.get('/api/auth/oidc/callback', { logLevel: 'silent' }, async (req, reply) => {
    const s = await enabled();
    let pending: PendingSignIn | null = null;
    try {
      pending = JSON.parse(decrypt(req.cookies[OIDC_COOKIE] ?? '')) as PendingSignIn;
    } catch {
      // missing or not ours: `expired` below
    }
    reply.clearCookie(OIDC_COOKIE, { path: COOKIE_PATH });
    const connecting = pending?.connectSessionId ?? null;

    const fail = async (code: string, reason: string, userId?: string) => {
      if (!connecting) recordLoginFailure(req.ip, null);
      req.log.warn({ event: 'auth.failed', ip: req.ip, reason }, 'OpenID sign-in failed');
      await audit(db, {
        actorUserId: userId,
        actorIp: req.ip,
        action: 'login_failed',
        entityType: 'user',
        entityId: userId,
        summary: `Failed ${s.label} sign-in (${code}: ${reason.slice(0, 200)})`,
      });
      return reply.redirect(withParam(connecting ? pending!.next : '/login', 'sso_error', code));
    };

    if (!connecting && isLoginBlocked(req.ip, null)) return fail('too_many', 'rate limited');
    if (!pending || pending.exp < Date.now()) return fail('expired', 'no sign-in in progress');
    const q = req.query as Record<string, unknown>;
    if (typeof q.error === 'string')
      return fail(q.error === 'access_denied' ? 'denied' : 'provider', `provider: ${q.error}`);

    let r;
    try {
      r = await finishSignIn(s, new URL(`https://${host}${req.url}`), pending);
    } catch (err) {
      return fail('provider', oidcError(err));
    }
    const d = decide(s, r.claims);
    const email = typeof r.claims.email === 'string' ? r.claims.email : null;
    if (!d.allowed) return fail('not_allowed', `${email ?? r.subject} not in the allowed groups`);
    const [owner] = await db
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(and(eq(userIdentities.kind, 'oidc'), eq(userIdentities.subject, r.subject)));

    if (connecting) {
      // Connect (12 §3.3): to the user of the session that asked, if it's still signed in.
      const [sess] = await db
        .select({ userId: sessions.userId, email: users.email })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.id, connecting),
            gt(sessions.expiresAt, new Date()),
            eq(users.isActive, true),
          ),
        );
      if (!sess) return fail('expired', 'the session that asked has ended');
      if (owner && owner.userId !== sess.userId)
        return fail('taken', `${email ?? r.subject} belongs to another user`, sess.userId);
      await db.transaction(async (tx) => {
        await tx
          .delete(userIdentities)
          .where(and(eq(userIdentities.userId, sess.userId), eq(userIdentities.kind, 'oidc')));
        await tx.insert(userIdentities).values({
          userId: sess.userId,
          kind: 'oidc',
          subject: r.subject,
          email,
          groups: d.groups,
        });
      });
      await audit(db, {
        actorUserId: sess.userId,
        actorIp: req.ip,
        action: 'sso_connected',
        entityType: 'user',
        entityId: sess.userId,
        summary: `${sess.email} connected ${s.label} account ${email ?? r.subject}`,
      });
      return reply.redirect(withParam(pending.next, 'sso', 'connected'));
    }

    let userId = owner?.userId;
    if (!userId) {
      // A user without a password or an OpenID account yet, by verified email (12 §3.3 step 2).
      const v = verifiedEmail(r.claims, s.trustEmail);
      const [u] = v
        ? await db
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.email, v),
                isNull(users.passwordHash),
                notExists(
                  db
                    .select({ id: userIdentities.id })
                    .from(userIdentities)
                    .where(
                      and(eq(userIdentities.userId, users.id), eq(userIdentities.kind, 'oidc')),
                    ),
                ),
              ),
            )
        : [];
      if (!u) return fail('not_connected', `${email ?? r.subject} isn't connected to a user`);
      await db
        .insert(userIdentities)
        .values({ userId: u.id, kind: 'oidc', subject: r.subject, email, groups: d.groups });
      await audit(db, {
        actorUserId: u.id,
        actorIp: req.ip,
        action: 'sso_connected',
        entityType: 'user',
        entityId: u.id,
        summary: `${v} connected ${s.label} by verified email`,
      });
      userId = u.id;
    }
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user!.isActive) return fail('disabled', `${user!.email} is disabled`, userId);

    await applyClaims(db, req.log, s, userId, d, email, req.ip);
    await db
      .update(userIdentities)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(userIdentities.userId, userId), eq(userIdentities.kind, 'oidc')));
    const token = await createSession(
      db,
      userId,
      req.ip,
      req.headers['user-agent'] ?? null,
      'oidc',
      { refreshToken: r.refreshToken, idToken: r.idToken },
    );
    setSessionCookie(reply, token);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
    await audit(db, {
      actorUserId: userId,
      actorIp: req.ip,
      action: 'login',
      entityType: 'user',
      entityId: userId,
      summary: `${user!.email} signed in with ${s.label}`,
    });
    req.log.info({ event: 'auth.oidc', userId }, 'OpenID sign-in');
    return reply.redirect(pending.next);
  });

  /** Disconnect (12 §3.3): refused when it would leave them no way in under the current mode. */
  async function disconnect(req: FastifyRequest, reply: FastifyReply, userId: string) {
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u) throw notFound('User not found');
    const ids = await db
      .select({ kind: userIdentities.kind })
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId));
    if (!ids.some((i) => i.kind === 'oidc')) throw notFound('No OpenID account is connected');
    const mode = await getSetting(db, 'auth.mode');
    const passwordWay = u.passwordHash !== null || ids.some((i) => i.kind === 'ldap');
    if (!passwordWay || (mode === 'oidc' && u.role !== 'admin'))
      throw new HttpError(409, 'last_way_in', 'That would leave no way to sign in');
    await db
      .delete(userIdentities)
      .where(and(eq(userIdentities.userId, userId), eq(userIdentities.kind, 'oidc')));
    await db.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.method, 'oidc')));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'sso_disconnected',
      entityType: 'user',
      entityId: userId,
      summary: `Disconnected the OpenID account of ${u.email}`,
    });
    return reply.send({ ok: true });
  }

  app.delete('/api/me/identities/oidc', { preHandler: requireAuth }, (req, reply) =>
    disconnect(req, reply, req.user!.id),
  );
  app.delete('/api/users/:id/identities/oidc', { preHandler: requireAdmin }, (req, reply) =>
    disconnect(req, reply, z.object({ id: z.uuid() }).parse(req.params).id),
  );
}
