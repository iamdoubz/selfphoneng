// SPDX-License-Identifier: AGPL-3.0-or-later
// A directory entry → its SelfPhoneNG user (12 §4.3): connected before, or by the directory's
// email. Never a new user (owner, 2026-10-25).
import { and, eq } from 'drizzle-orm';
import { deleteUserSessions } from '../auth/sessions.ts';
import type { Db } from '../db/client.ts';
import { userIdentities, users } from '../db/schema.ts';
import { isLastAdmin } from '../routes/users.ts';
import { audit } from '../services/audit.ts';
import { getSetting, setSetting } from '../services/settings.ts';
import { lookupIds, type DirectoryEntry, type LdapSettings } from './ldap.ts';
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
  return byEmail && byEmailOk(byEmail) ? byEmail : null;
}

/**
 * Who a directory email may connect to on its own (12 §4.3 step 2): not an admin, and nobody
 * who chose their own password (none, or only the temporary one from Users). Anyone else
 * connects on My settings with both passwords: a directory that lets people edit their own
 * `mail` must not hand out the admin's account.
 */
const byEmailOk = (u: UserRow) =>
  u.role !== 'admin' && (u.passwordHash === null || u.mustChangePassword);

/** Connect a directory account the person proved (My settings, 12 §4.3). */
export async function connectDirectory(
  db: Db,
  log: { info(o: object, m: string): void },
  userId: string,
  e: DirectoryEntry,
  ip: string,
): Promise<'connected' | 'taken'> {
  const [owner] = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(and(eq(userIdentities.kind, 'ldap'), eq(userIdentities.subject, e.id)));
  if (owner && owner.userId !== userId) return 'taken';
  await db.transaction(async (tx) => {
    await tx
      .delete(userIdentities)
      .where(and(eq(userIdentities.userId, userId), eq(userIdentities.kind, 'ldap')));
    await tx
      .insert(userIdentities)
      .values({ userId, kind: 'ldap', subject: e.id, email: e.email, lastUsedAt: new Date() });
  });
  await audit(db, {
    actorUserId: userId,
    actorIp: ip,
    action: 'ldap_connected',
    entityType: 'user',
    entityId: userId,
    summary: `Connected directory account ${e.dn}`,
  });
  await applyRole(db, log, userId, e.admin, 'the directory', ip);
  return 'connected';
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

/** The dashboard's directory warning (12 §4.2, §4.5); null clears it. */
export const directoryWarning = (db: Db, message: string | null) =>
  setSetting(db, 'system.directoryWarning', message);

type Log = { info(o: object, m: string): void; warn?(o: object, m: string): void };

/**
 * One run of the directoryCheck job (hourly, 12 §4.5): every active user with a directory
 * account still in it gets its email and role; one who isn't is disabled. Never re-enables.
 * `lookup` is for tests.
 */
export async function checkDirectory(d: {
  db: Db;
  log: Log;
  lookup?: (s: LdapSettings, ids: string[]) => Promise<Map<string, DirectoryEntry>>;
}): Promise<void> {
  const { db, log } = d;
  const s = await getSetting(db, 'auth.ldap');
  const rows = s?.enabled
    ? await db
        .select({ u: users, subject: userIdentities.subject })
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .where(and(eq(userIdentities.kind, 'ldap'), eq(users.isActive, true)))
    : [];
  if (!s || !rows.length) return directoryWarning(db, null);

  let found: Map<string, DirectoryEntry>;
  try {
    found = await (d.lookup ?? lookupIds)(
      s,
      rows.map((r) => r.subject),
    );
  } catch (err) {
    log.warn?.({ err: (err as Error).message }, 'directory check skipped');
    return directoryWarning(
      db,
      `The directory check couldn't reach the directory (${(err as Error).message}), so leavers aren't being disabled.`,
    );
  }
  const gone = rows.filter((r) => !found.has(r.subject));
  // A broken filter or base DN is likelier than a mass layoff.
  if (gone.length >= 3 && gone.length * 2 > rows.length) {
    log.warn?.({ gone: gone.length, of: rows.length }, 'directory check would disable most users');
    return directoryWarning(
      db,
      `The directory check would disable ${gone.length} of ${rows.length} people, so it disabled nobody. Check the base DN and user filter.`,
    );
  }

  for (const { u, subject } of rows) {
    const e = found.get(subject);
    if (e) {
      await db
        .update(userIdentities)
        .set({ email: e.email })
        .where(and(eq(userIdentities.userId, u.id), eq(userIdentities.kind, 'ldap')));
      await applyRole(db, log, u.id, e.admin, 'the directory', null);
      continue;
    }
    if (u.role === 'admin' && u.passwordHash && (await isLastAdmin(db, u.id))) {
      log.warn?.(
        { userId: u.id },
        'kept the last admin with a password, though the directory lost them',
      );
      continue;
    }
    await db.update(users).set({ isActive: false }).where(eq(users.id, u.id));
    await deleteUserSessions(db, u.id);
    await audit(db, {
      action: 'directory_disabled',
      entityType: 'user',
      entityId: u.id,
      summary: `${u.email} is no longer in the directory`,
      diff: { before: { isActive: true }, after: { isActive: false } },
    });
  }
  await directoryWarning(db, null);
}
