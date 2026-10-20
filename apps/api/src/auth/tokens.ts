// SPDX-License-Identifier: AGPL-3.0-or-later
// API tokens (04 §2.3): `Authorization: Bearer sp_<40 base62>`, stored as sha256, acting as the
// admin who made them.
import { createHash, randomInt } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { apiTokens, users } from '../db/schema.ts';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const TOKEN_RE = /^sp_[A-Za-z0-9]{40}$/;
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function generateToken(): string {
  let s = 'sp_';
  for (let i = 0; i < 40; i++) s += BASE62[randomInt(62)];
  return s;
}

/** The token's (active) user, or null for an unknown, revoked or malformed token. */
export async function getTokenUser(db: Db, token: string) {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await db
    .select({ id: apiTokens.id, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.createdBy))
    .where(
      and(
        eq(apiTokens.tokenHash, hashToken(token)),
        isNull(apiTokens.revokedAt),
        eq(users.isActive, true),
      ),
    );
  if (!row) return null;
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));
  return { user: row.user, tokenId: row.id };
}
