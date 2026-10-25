// SPDX-License-Identifier: AGPL-3.0-or-later
// The role a provider says (12 §1): OpenID adminGroups or the LDAP adminFilter.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { isLastAdmin } from '../routes/users.ts';
import { audit } from '../services/audit.ts';

/** admin null: the role is managed here. Never demotes the last admin with a password. */
export async function applyRole(
  db: Db,
  log: { info(o: object, m: string): void },
  userId: string,
  admin: boolean | null,
  source: string,
  actorIp: string | null,
): Promise<void> {
  if (admin === null) return;
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const role = admin ? 'admin' : 'user';
  if (!user || role === user.role) return;
  if (role === 'user' && (await isLastAdmin(db, userId))) {
    log.info({ userId }, `kept the last admin with a password, though ${source} says user`);
    return;
  }
  await db.update(users).set({ role }).where(eq(users.id, userId));
  await audit(db, {
    actorIp: actorIp ?? undefined,
    action: 'update',
    entityType: 'user',
    entityId: userId,
    summary: `${user.email} is now ${role}, from ${source}`,
    diff: { before: { role: user.role }, after: { role } },
  });
}
