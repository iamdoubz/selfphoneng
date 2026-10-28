// SPDX-License-Identifier: AGPL-3.0-or-later
// Sign in with OpenID Connect, connect and disconnect an OpenID account (12 §3.2, §3.3).
import { and, eq, gt, isNull, ne, notExists } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decrypt, encrypt } from '../crypto/secrets.ts';
import { sessions, userIdentities, users } from '../db/schema.ts';
import {
  HttpError,
  badRequest,
  forbidden,
  notFound,
  rateLimited,
  unauthorized,
} from '../errors.ts';
import { requireAdmin, requireAuth } from '../auth/guards.ts';
import { isLoginBlocked, recordLoginFailure } from '../auth/login-limiter.ts';
import { COOKIE, createSession, getSessionUser, setSessionCookie } from '../auth/sessions.ts';
import { audit } from '../services/audit.ts';
import { getSetting } from '../services/settings.ts';
import { decide, verifiedEmail } from '../sso/claims.ts';
import { connectDirectory } from '../sso/directory.ts';
import { ldapAuthenticate } from '../sso/ldap.ts';
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

/**
 * Same-site paths only: never send the browser to another origin. No backslash or control
 * character anywhere: browsers drop tabs and newlines from URLs, so "/<tab>/evil.example"
 * would become "//evil.example".
 */
export const safeNext = (p: string | undefined) =>
  // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  p && /^\/(?!\/)[^\\\x00-\x1f\x7f]*$/.test(p) ? p : undefined;

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

  /** The sp_oidc cookie: what the callback checks the provider's answer against. */
  async function begin(reply: FastifyReply, s: OidcSettings, next: string, connect: string | null) {
    const { url, pending } = await startSignIn(s, host, next, connect);
    reply.setCookie(OIDC_COOKIE, encrypt(JSON.stringify(pending)), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: COOKIE_PATH,
      maxAge: 600,
    });
    return url.href;
  }

  app.get('/api/auth/oidc/start', async (req, reply) => {
    const s = await enabled();
    const q = z.object({ next: z.string().max(500).optional() }).parse(req.query);
    try {
      return reply.redirect(await begin(reply, s, safeNext(q.next) ?? '/', null));
    } catch (err) {
      req.log.warn({ event: 'auth.oidc', err: oidcError(err) }, 'OpenID discovery failed');
      return reply.redirect(withParam('/login', 'sso_error', 'provider'));
    }
  });

  /**
   * Connect from My account (12 §3.3). A POST, so it needs the CSRF header: another site can't
   * start it and connect whatever provider account the browser is signed in to. The page then
   * sends the browser to `url`.
   */
  app.post('/api/auth/oidc/connect', { preHandler: requireAuth }, async (req, reply) => {
    const s = await enabled();
    if (!req.sessionId) throw unauthorized(); // an API token can't connect an account
    const q = z.object({ next: z.string().max(500).optional() }).parse(req.body ?? {});
    const next =
      safeNext(q.next) ?? (req.user!.role === 'admin' ? '/admin/account' : '/me/settings');
    try {
      return { url: await begin(reply, s, next, req.sessionId) };
    } catch (err) {
      req.log.warn({ event: 'auth.oidc', err: oidcError(err) }, 'OpenID discovery failed');
      throw new HttpError(502, 'provider', `${s.label} can't be reached`);
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
      // Connect (12 §3.3): to the user of the session that asked, if it's still signed in, and
      // only in that browser: a planted sp_oidc can't connect someone else's account (08 §7 #8).
      const here = req.cookies[COOKIE]
        ? await getSessionUser(db, req.cookies[COOKIE], false)
        : null;
      if (here?.sessionId !== connecting)
        return fail('expired', 'connect finished in another browser than the one that asked');
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
      // A user without a password or any connected account yet, by verified email (12 §3.3
      // step 2). Never an admin: a provider account with their email isn't them (08 §7 #2).
      const v = verifiedEmail(r.claims, s.trustEmail);
      const [u] = v
        ? await db
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.email, v),
                isNull(users.passwordHash),
                ne(users.role, 'admin'),
                notExists(
                  db
                    .select({ id: userIdentities.id })
                    .from(userIdentities)
                    .where(eq(userIdentities.userId, users.id)),
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

  /**
   * Disconnect an OpenID or directory account (12 §3.3, §4.3): refused when it would leave
   * them no way in under the current mode. Sessions made with it end.
   */
  async function disconnect(
    req: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    kind: 'oidc' | 'ldap',
  ) {
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u) throw notFound('User not found');
    const ids = await db
      .select({ kind: userIdentities.kind })
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId));
    if (!ids.some((i) => i.kind === kind)) throw notFound('No such account is connected');
    const left = ids.filter((i) => i.kind !== kind);
    const mode = await getSetting(db, 'auth.mode');
    const password = u.passwordHash !== null || left.some((i) => i.kind === 'ldap');
    const openid = mode !== 'password' && left.some((i) => i.kind === 'oidc');
    if (!openid && !(password && (mode !== 'oidc' || u.role === 'admin')))
      throw new HttpError(409, 'last_way_in', 'That would leave no way to sign in');
    await db
      .delete(userIdentities)
      .where(and(eq(userIdentities.userId, userId), eq(userIdentities.kind, kind)));
    await db.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.method, kind)));
    const what = kind === 'oidc' ? 'OpenID' : 'directory';
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'sso_disconnected',
      entityType: 'user',
      entityId: userId,
      summary: `Disconnected the ${what} account of ${u.email}`,
    });
    return reply.send({ ok: true });
  }

  const Kind = z.object({ kind: z.enum(['oidc', 'ldap']) });
  app.delete('/api/me/identities/:kind', { preHandler: requireAuth }, (req, reply) => {
    const { kind } = Kind.parse(req.params);
    // The directory account is how a leaver gets disabled (12 §4.5): only an admin drops it.
    if (kind === 'ldap' && req.user!.role !== 'admin')
      throw forbidden('Ask an admin to disconnect your directory account', 'admin_only');
    return disconnect(req, reply, req.user!.id, kind);
  });

  /**
   * Connect my directory account (12 §4.3): its username and password, checked by the directory,
   * while signed in here. Counted like a sign-in by the login limiter.
   */
  app.post('/api/me/identities/ldap', { preHandler: requireAuth }, async (req) => {
    if (!req.sessionId) throw unauthorized(); // an API token can't connect an account
    const { login, password } = z
      .object({ login: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) })
      .parse(req.body);
    const ldap = await getSetting(db, 'auth.ldap');
    if (!ldap?.enabled) throw notFound();
    if (isLoginBlocked(req.ip, login)) throw rateLimited();
    let entry;
    try {
      entry = await ldapAuthenticate(ldap, login, password);
    } catch {
      recordLoginFailure(req.ip, login);
      throw new HttpError(503, 'directory_unavailable', 'The directory can’t be reached');
    }
    if (!entry) {
      recordLoginFailure(req.ip, login);
      throw badRequest('The directory refused that username or password');
    }
    const r = await connectDirectory(db, req.log, req.user!.id, entry, req.ip);
    if (r === 'taken')
      throw new HttpError(409, 'taken', 'That directory account belongs to another user');
    if (r === 'connected_other')
      throw new HttpError(
        409,
        'connected_other',
        'Another directory account is connected. Ask an admin to disconnect it first',
      );
    return { ok: true };
  });
  app.delete('/api/users/:id/identities/:kind', { preHandler: requireAdmin }, (req, reply) => {
    const p = Kind.extend({ id: z.uuid() }).parse(req.params);
    return disconnect(req, reply, p.id, p.kind);
  });
}
