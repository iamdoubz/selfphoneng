// SPDX-License-Identifier: AGPL-3.0-or-later
// preHandler guards (04 §2.4). Routes list them in `preHandler`.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { users } from '../db/schema.ts';
import { forbidden, unauthorized } from '../errors.ts';
import { COOKIE, getSessionUser, setSessionCookie } from './sessions.ts';

export type CurrentUser = typeof users.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    user: CurrentUser | null;
    sessionId: string | null;
  }
}

/** Sets req.user from the session cookie. Enforces must_change_password outside /api/auth/*. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[COOKIE];
  const found = token ? await getSessionUser(req.server.db, token) : null;
  if (!found) throw unauthorized();
  if (found.extended) setSessionCookie(reply, token!);
  req.user = found.user;
  req.sessionId = found.sessionId;
  if (found.user.mustChangePassword && !req.url.startsWith('/api/auth/'))
    throw forbidden('Change your password first', 'password_change_required');
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (req.user!.role !== 'admin') throw forbidden('Admins only');
}
