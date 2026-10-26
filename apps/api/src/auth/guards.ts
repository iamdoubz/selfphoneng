// SPDX-License-Identifier: AGPL-3.0-or-later
// preHandler guards (04 §2.4). Routes list them in `preHandler`; the rate limit presets go in
// `config`.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { users } from '../db/schema.ts';
import { forbidden, unauthorized } from '../errors.ts';
import { COOKIE, getSessionUser, mustChange, setSessionCookie } from './sessions.ts';
import { getTokenUser } from './tokens.ts';

export type CurrentUser = typeof users.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    user: CurrentUser | null;
    sessionId: string | null;
    /** Set when the request came with an API token instead of a session. */
    apiTokenId?: string;
  }
}

/**
 * Sets req.user from an API token (Authorization: Bearer, 04 §2.3) or else the session cookie.
 * Enforces must_change_password outside /api/auth/*.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const t = await getTokenUser(req.server.db, auth.slice(7).trim());
    if (!t) throw unauthorized();
    req.user = t.user;
    req.sessionId = null;
    req.apiTokenId = t.tokenId;
    if (t.user.mustChangePassword)
      throw forbidden('Change your password first', 'password_change_required');
    return;
  }
  const token = req.cookies[COOKIE];
  const found = token ? await getSessionUser(req.server.db, token) : null;
  if (!found) throw unauthorized();
  if (found.extended) setSessionCookie(reply, token!);
  req.user = found.user;
  req.sessionId = found.sessionId;
  if (mustChange(found) && !req.url.startsWith('/api/auth/'))
    throw forbidden('Change your password first', 'password_change_required');
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (req.user!.role !== 'admin') throw forbidden('Admins only');
}

/** Route `config` for what calls out or does real work (Test buttons, downloads): 10 a minute. */
export const SLOW = { rateLimit: { max: 10, timeWindow: 60_000 } };
/** Route `config` for routes with their own limit (/prov) or only Asterisk on this machine. */
export const NO_LIMIT = { rateLimit: false as const };
