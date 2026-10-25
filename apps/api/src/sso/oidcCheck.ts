// SPDX-License-Identifier: AGPL-3.0-or-later
// What the provider says about a user, applied (12 §3.4), and the leaver check (12 §3.5): every
// OpenID session is refreshed at the provider every 15 minutes, and ends when it says no.
import { and, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import * as oidc from 'openid-client';
import type { Db } from '../db/client.ts';
import { decrypt, encrypt } from '../crypto/secrets.ts';
import { sessions, userIdentities, users } from '../db/schema.ts';
import { isLastAdmin } from '../routes/users.ts';
import { audit } from '../services/audit.ts';
import { getSetting } from '../services/settings.ts';
import { decide, type ClaimsDecision } from './claims.ts';
import { oidcConfig, oidcError, type OidcSettings } from './oidc.ts';

type Log = { info(o: object, m: string): void; warn?(o: object, m: string): void };

/** The role from adminGroups (never demoting the last admin with a password), groups, email. */
export async function applyClaims(
  db: Db,
  log: Log,
  s: OidcSettings,
  userId: string,
  d: ClaimsDecision,
  email: string | null,
  actorIp: string | null,
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return;
  const role = d.admin === null ? user.role : d.admin ? 'admin' : 'user';
  if (role !== user.role) {
    if (role === 'user' && (await isLastAdmin(db, userId)))
      log.info({ userId }, `kept the last admin with a password, though ${s.label} says user`);
    else {
      await db.update(users).set({ role }).where(eq(users.id, userId));
      await audit(db, {
        actorIp: actorIp ?? undefined,
        action: 'update',
        entityType: 'user',
        entityId: userId,
        summary: `${user.email} is now ${role}, from ${s.label}'s groups`,
        diff: { before: { role: user.role }, after: { role } },
      });
    }
  }
  await db
    .update(userIdentities)
    .set({ email, groups: d.groups })
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.kind, 'oidc')));
}

const CHECK_EVERY_MS = 15 * 60_000;

/** One run of the oidcCheck job (every 5 minutes): sessions not checked for 15 minutes. */
export async function checkOidcSessions(d: { db: Db; log: Log; now?: Date }): Promise<void> {
  const { db, log } = d;
  const now = d.now ?? new Date();
  const s = await getSetting(db, 'auth.oidc');
  if (!s) return;
  const due = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      refreshEnc: sessions.idpRefreshEnc,
      email: users.email,
      subject: userIdentities.subject,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(
      userIdentities,
      and(eq(userIdentities.userId, sessions.userId), eq(userIdentities.kind, 'oidc')),
    )
    .where(
      and(
        eq(sessions.method, 'oidc'),
        isNotNull(sessions.idpRefreshEnc),
        gt(sessions.expiresAt, now),
        or(
          isNull(sessions.idpCheckedAt),
          lt(sessions.idpCheckedAt, new Date(now.getTime() - CHECK_EVERY_MS)),
        ),
      ),
    );
  if (!due.length) return;
  let config: oidc.Configuration;
  try {
    config = await oidcConfig(s);
  } catch (err) {
    log.warn?.({ err: oidcError(err) }, 'OpenID check skipped: the provider is unreachable');
    return;
  }

  const end = async (row: (typeof due)[number], why: string) => {
    await db.delete(sessions).where(eq(sessions.id, row.id));
    await audit(db, {
      actorUserId: row.userId,
      action: 'logout',
      entityType: 'user',
      entityId: row.userId,
      summary: `${row.email} signed out: ${why}`,
    });
  };

  for (const row of due) {
    // Disconnected since (Disconnect also ends these sessions; this is the belt to its braces).
    if (!row.subject) {
      await end(row, `no ${s.label} account connected any more`);
      continue;
    }
    let tokens: Awaited<ReturnType<typeof oidc.refreshTokenGrant>>;
    let claims: Record<string, unknown>;
    try {
      tokens = await oidc.refreshTokenGrant(config, decrypt(row.refreshEnc!));
      const sub = row.subject.slice(row.subject.indexOf(' ') + 1);
      claims = config.serverMetadata().userinfo_endpoint
        ? { ...(await oidc.fetchUserInfo(config, tokens.access_token, sub)) }
        : { ...tokens.claims() };
    } catch (err) {
      // The provider said no: disabled, signed out there, or the refresh token expired.
      if (err instanceof oidc.ResponseBodyError && err.error === 'invalid_grant') {
        await end(row, `${s.label} ended the session (${oidcError(err)})`);
        continue;
      }
      // Down, 5xx, a bad client setup: keep the session and try again next run.
      log.warn?.({ err: oidcError(err) }, `OpenID check of a session failed`);
      continue;
    }
    const verdict = decide(s, claims);
    if (!verdict.allowed) {
      await end(row, `no longer in ${s.label}'s allowed groups`);
      continue;
    }
    await db
      .update(sessions)
      .set({
        idpCheckedAt: now,
        ...(tokens.refresh_token && { idpRefreshEnc: encrypt(tokens.refresh_token) }),
        ...(tokens.id_token && { idpIdTokenEnc: encrypt(tokens.id_token) }),
      })
      .where(eq(sessions.id, row.id));
    const email = typeof claims.email === 'string' ? claims.email : null;
    await applyClaims(db, log, s, row.userId, verdict, email, null);
  }
}
