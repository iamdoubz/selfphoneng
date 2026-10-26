// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser sessions (04 §2.2): random token in the cookie, sha256(token) in sessions.id.
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, ne } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { Db } from '../db/client.ts';
import { encrypt } from '../crypto/secrets.ts';
import { sessions, users } from '../db/schema.ts';

export const COOKIE = 'sp_session';
const DAY = 86_400_000;
const LIFETIME = 14 * DAY;
const EXTEND_BELOW = 7 * DAY;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: LIFETIME / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { path: '/' });
}

export async function createSession(
  db: Db,
  userId: string,
  ip: string | null,
  userAgent: string | null,
  method: 'password' | 'ldap' | 'oidc' = 'password',
  /** OpenID sessions (12 §3.5): kept encrypted for the leaver check and signing out there. */
  idp?: { refreshToken: string | null; idToken: string },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({
    id: sha256(token),
    userId,
    expiresAt: new Date(Date.now() + LIFETIME),
    ip,
    userAgent: userAgent?.slice(0, 500) ?? null,
    method,
    idpRefreshEnc: idp?.refreshToken ? encrypt(idp.refreshToken) : null,
    idpIdTokenEnc: idp ? encrypt(idp.idToken) : null,
    idpCheckedAt: idp ? new Date() : null,
  });
  return token;
}

/**
 * Resolves a cookie token to its active user, sliding the expiry when under 7 days are left
 * (not for the live socket's re-checks: an open dashboard alone doesn't keep a session going).
 */
export async function getSessionUser(db: Db, token: string, slide = true) {
  const id = sha256(token);
  const [row] = await db
    .select({ expiresAt: sessions.expiresAt, method: sessions.method, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date()), eq(users.isActive, true)));
  if (!row) return null;
  let extended = false;
  if (slide && row.expiresAt.getTime() - Date.now() < EXTEND_BELOW) {
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + LIFETIME) })
      .where(eq(sessions.id, id));
    extended = true;
  }
  return { user: row.user, sessionId: id, method: row.method, extended };
}

/** A password to change only blocks sessions made with it (OpenID sessions skip it, 12). */
export const mustChange = (f: { user: { mustChangePassword: boolean }; method: string }) =>
  f.user.mustChangePassword && f.method === 'password';

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

/** Logs a user out everywhere except (optionally) the current session. */
export async function deleteUserSessions(db: Db, userId: string, keepSessionId?: string) {
  await db
    .delete(sessions)
    .where(
      keepSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))
        : eq(sessions.userId, userId),
    );
}
