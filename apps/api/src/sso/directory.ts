// SPDX-License-Identifier: AGPL-3.0-or-later
// A directory entry → its SelfPhoneNG user (12 §4.3): connected before, or by the directory's
// email. Never a new user (owner, 2026-10-25).
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { userIdentities, users } from '../db/schema.ts';
import { audit } from '../services/audit.ts';
import type { DirectoryEntry } from './ldap.ts';
import { applyRole } from './role.ts';

type UserRow = typeof users.$inferSelect;

/** Who this entry is here, without changing anything (Settings → Test says it too). */
export async function directoryUserFor(db: Db, e: DirectoryEntry): Promise<UserRow | null> {
  const [byId] = await db
    .select({ u: users })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.kind, 'ldap'), eq(userIdentities.subject, e.id)));
  if (byId) return byId.u;
  if (!e.email) return null;
  const [byEmail] = await db.select().from(users).where(eq(users.email, e.email));
  return byEmail ?? null;
}

/**
 * The user this directory sign-in is for, connected now if it was matched by email (the
 * directory is the company's own and the person just proved its password), with the role from
 * adminFilter. Null: nobody here has this directory account or email.
 */
export async function directorySignIn(
  db: Db,
  log: { info(o: object, m: string): void },
  e: DirectoryEntry,
  ip: string,
): Promise<UserRow | null> {
  const u = await directoryUserFor(db, e);
  if (!u) return null;
  const [mine] = await db
    .select({ subject: userIdentities.subject })
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, u.id), eq(userIdentities.kind, 'ldap')));
  if (!mine) {
    await db.insert(userIdentities).values({
      userId: u.id,
      kind: 'ldap',
      subject: e.id,
      email: e.email,
      lastUsedAt: new Date(),
    });
    await audit(db, {
      actorUserId: u.id,
      actorIp: ip,
      action: 'ldap_connected',
      entityType: 'user',
      entityId: u.id,
      summary: `${u.email} connected directory account ${e.dn}`,
    });
  } else if (mine.subject !== e.id) {
    // Their email matches, but another directory account is already theirs: not this one.
    log.info({ userId: u.id }, `directory entry ${e.dn} matches by email but isn't theirs`);
    return null;
  } else
    await db
      .update(userIdentities)
      .set({ email: e.email, lastUsedAt: new Date() })
      .where(and(eq(userIdentities.userId, u.id), eq(userIdentities.kind, 'ldap')));
  await applyRole(db, log, u.id, e.admin, 'the directory', ip);
  const [after] = await db.select().from(users).where(eq(users.id, u.id));
  return after!;
}
