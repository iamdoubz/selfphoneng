// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/auth/* (04 §2, §7.3).
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  ChangePasswordSchema,
  LoginSchema,
  PasswordConfirmSchema,
  TotpEnableSchema,
  APP_NAME,
  type AuthMethods,
  type AuthUser,
  type SignInWays,
  type TotpSetup,
  type TotpStatus,
} from '@selfphoneng/shared';
import QRCode from 'qrcode';
import { decrypt, encrypt } from '../crypto/secrets.ts';
import {
  checkTotp,
  hashRecovery,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUrl,
} from '../auth/totp.ts';
import type { Db } from '../db/client.ts';
import { extensions, sessions, userIdentities, users } from '../db/schema.ts';
import { endSessionUrl, oidcError } from '../sso/oidc.ts';
import { getSetting } from '../services/settings.ts';
import {
  unauthorized,
  rateLimited,
  badRequest,
  conflict,
  forbidden,
  HttpError,
} from '../errors.ts';
import { audit } from '../services/audit.ts';
import { requireAuth, type CurrentUser } from '../auth/guards.ts';
import { isLoginBlocked, recordLoginFailure } from '../auth/login-limiter.ts';
import {
  assertPasswordPolicy,
  burnVerify,
  hashPassword,
  verifyPassword,
} from '../auth/passwords.ts';
import {
  COOKIE,
  clearSessionCookie,
  createSession,
  deleteSession,
  deleteUserSessions,
  setSessionCookie,
} from '../auth/sessions.ts';

/** 12 §2: the user's password and connected accounts, from their user_identities rows. */
export const signInWays = (
  u: { passwordHash: string | null },
  ids: { kind: 'oidc' | 'ldap'; email: string | null; groups: string[] }[],
): SignInWays => {
  const oidc = ids.find((i) => i.kind === 'oidc');
  return {
    password: u.passwordHash !== null,
    oidc: oidc ? { email: oidc.email, groups: oidc.groups } : null,
    ldap: ids.some((i) => i.kind === 'ldap'),
  };
};

export async function toAuthUser(db: Db, u: CurrentUser): Promise<AuthUser> {
  const [ext] = await db
    .select({ id: extensions.id, number: extensions.number, name: extensions.name })
    .from(extensions)
    .where(eq(extensions.userId, u.id));
  const ids = await db
    .select({
      kind: userIdentities.kind,
      email: userIdentities.email,
      groups: userIdentities.groups,
    })
    .from(userIdentities)
    .where(eq(userIdentities.userId, u.id));
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
    extension: ext ?? null,
    signIn: signInWays(u, ids),
  };
}

export async function authRoutes(app: FastifyInstance) {
  const { db } = app;

  /**
   * A TOTP code (each 30 s step once) or an unused recovery code, consumed atomically so two
   * logins can't both use it.
   */
  async function useSecondFactor(u: typeof users.$inferSelect, code: string): Promise<boolean> {
    const step = checkTotp(decrypt(u.totpSecretEnc!), code, u.totpLastStep);
    if (step !== null) {
      const r = await db
        .update(users)
        .set({ totpLastStep: step })
        .where(
          and(eq(users.id, u.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))),
        )
        .returning({ id: users.id });
      return r.length === 1;
    }
    if (/^\d+$/.test(code)) return false;
    const h = hashRecovery(code);
    const r = await db
      .update(users)
      .set({ totpRecoveryHashes: sql`array_remove(${users.totpRecoveryHashes}, ${h})` })
      .where(and(eq(users.id, u.id), sql`${h} = any(${users.totpRecoveryHashes})`))
      .returning({ id: users.id });
    return r.length === 1;
  }

  const myRow = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0]!;
  /** Two-step sign-in is for admins (08 §2.4). */
  const adminOnly = (u: CurrentUser) => {
    if (u.role !== 'admin') throw forbidden('Two-step sign-in is for admins');
  };

  app.get('/api/auth/totp', { preHandler: requireAuth }, async (req): Promise<TotpStatus> => {
    const u = await myRow(req.user!.id);
    return { enabled: !!u.totpSecretEnc, recoveryCodesLeft: u.totpRecoveryHashes.length };
  });

  /** A fresh secret to scan; nothing is stored until /enable confirms a code from it. */
  app.post('/api/auth/totp/setup', { preHandler: requireAuth }, async (req): Promise<TotpSetup> => {
    adminOnly(req.user!);
    const secret = newTotpSecret();
    const url = otpauthUrl(secret, req.user!.email, `${APP_NAME} ${app.config.PUBLIC_HOSTNAME}`);
    return { secret, otpauthUrl: url, qr: await QRCode.toDataURL(url, { margin: 2, width: 240 }) };
  });

  app.post('/api/auth/totp/enable', { preHandler: requireAuth }, async (req) => {
    adminOnly(req.user!);
    const { secret, code, password } = TotpEnableSchema.parse(req.body);
    const u = await myRow(req.user!.id);
    if (u.totpSecretEnc) throw conflict('Two-step sign-in is already on');
    // Like turning it off: a stolen session alone can't lock the owner out with its own secret.
    if (!u.passwordHash || !(await verifyPassword(u.passwordHash, password)))
      throw badRequest('Wrong password');
    const step = checkTotp(secret, code, null);
    if (step === null)
      throw badRequest('That code doesn’t match. Check the phone’s clock and try again.');
    const { codes, hashes } = newRecoveryCodes();
    await db
      .update(users)
      .set({ totpSecretEnc: encrypt(secret), totpLastStep: step, totpRecoveryHashes: hashes })
      .where(eq(users.id, req.user!.id));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'totp_enabled',
      entityType: 'user',
      entityId: req.user!.id,
      summary: `${req.user!.email} turned on two-step sign-in`,
    });
    return { recoveryCodes: codes };
  });

  /** Turning it off or making new recovery codes needs the password again (on does too). */
  async function confirmPassword(id: string, body: unknown) {
    const { password } = PasswordConfirmSchema.parse(body);
    const u = await myRow(id);
    if (!u.passwordHash || !(await verifyPassword(u.passwordHash, password)))
      throw badRequest('Wrong password');
    return u;
  }

  app.post('/api/auth/totp/disable', { preHandler: requireAuth }, async (req) => {
    await confirmPassword(req.user!.id, req.body);
    await db
      .update(users)
      .set({ totpSecretEnc: null, totpLastStep: null, totpRecoveryHashes: [] })
      .where(eq(users.id, req.user!.id));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'totp_disabled',
      entityType: 'user',
      entityId: req.user!.id,
      summary: `${req.user!.email} turned off two-step sign-in`,
    });
    return { ok: true };
  });

  app.post('/api/auth/totp/recovery-codes', { preHandler: requireAuth }, async (req) => {
    const u = await confirmPassword(req.user!.id, req.body);
    if (!u.totpSecretEnc) throw badRequest('Two-step sign-in is off');
    const { codes, hashes } = newRecoveryCodes();
    await db.update(users).set({ totpRecoveryHashes: hashes }).where(eq(users.id, u.id));
    await audit(db, {
      actorUserId: u.id,
      actorIp: req.ip,
      action: 'totp_recovery_codes',
      entityType: 'user',
      entityId: u.id,
      summary: `${u.email} made new recovery codes`,
    });
    return { recoveryCodes: codes };
  });

  /** The login page's choices (12 §2). Public: says nothing about any user. */
  app.get('/api/auth/methods', async (): Promise<AuthMethods> => {
    const mode = await getSetting(db, 'auth.mode');
    const oidc = await getSetting(db, 'auth.oidc');
    return {
      mode,
      ldap: false, // S4
      oidc: oidc && mode !== 'password' ? { label: oidc.label } : null,
    };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { login, ...body } = LoginSchema.parse(req.body);
    if (isLoginBlocked(req.ip, login)) throw rateLimited();
    const [user] = await db.select().from(users).where(eq(users.email, login));
    // No password (OpenID only, 12 §3.3) fails like a wrong one, after the same work.
    const ok =
      user?.isActive && user.passwordHash
        ? await verifyPassword(user.passwordHash, body.password)
        : (await burnVerify(body.password), false);
    if (!user || !ok) {
      recordLoginFailure(req.ip, login);
      req.log.warn({ event: 'auth.failed', ip: req.ip }, 'login failed');
      await audit(db, {
        actorUserId: user?.id,
        actorIp: req.ip,
        action: 'login_failed',
        entityType: 'user',
        entityId: user?.id,
        summary: `Failed login for ${login}`,
      });
      throw unauthorized('Wrong email or password');
    }
    // OpenID only (12 §1.1): passwords are for admins, the way in when the provider is down.
    if (user.role !== 'admin' && (await getSetting(db, 'auth.mode')) === 'oidc')
      throw forbidden('Use the sign-in button instead', 'password_sign_in_off');
    // Two-step sign-in (08 §2.4): the password was right; now the code.
    if (user.totpSecretEnc) {
      if (!body.totp)
        throw new HttpError(401, 'totp_required', 'Enter the code from your authenticator app');
      if (!(await useSecondFactor(user, body.totp))) {
        recordLoginFailure(req.ip, login);
        req.log.warn({ event: 'auth.failed', ip: req.ip }, 'login failed: code');
        await audit(db, {
          actorUserId: user.id,
          actorIp: req.ip,
          action: 'login_failed',
          entityType: 'user',
          entityId: user.id,
          summary: `Failed login for ${login} (wrong authenticator or recovery code)`,
        });
        throw new HttpError(401, 'totp_invalid', 'That code is wrong or was used already');
      }
    }
    const token = await createSession(db, user.id, req.ip, req.headers['user-agent'] ?? null);
    setSessionCookie(reply, token);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await audit(db, {
      actorUserId: user.id,
      actorIp: req.ip,
      action: 'login',
      entityType: 'user',
      entityId: user.id,
      summary: `${user.email} logged in`,
    });
    return { user: await toAuthUser(db, user) };
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const [sess] = req.sessionId
      ? await db.select().from(sessions).where(eq(sessions.id, req.sessionId))
      : [];
    await deleteSession(db, req.cookies[COOKIE]!);
    clearSessionCookie(reply);
    // Signed in with OpenID: sign out there too (12 §3.5). A provider problem doesn't stop ours.
    let redirect: string | null = null;
    const oidc = sess?.idpIdTokenEnc ? await getSetting(db, 'auth.oidc') : null;
    if (oidc)
      try {
        redirect = await endSessionUrl(
          oidc,
          app.config.PUBLIC_HOSTNAME,
          decrypt(sess!.idpIdTokenEnc!),
        );
      } catch (err) {
        req.log.warn({ event: 'auth.oidc', err: oidcError(err) }, 'no sign-out at the provider');
      }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'logout',
      entityType: 'user',
      entityId: req.user!.id,
      summary: `${req.user!.email} logged out`,
    });
    return redirect ? { ok: true, redirect } : { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => ({
    user: await toAuthUser(db, req.user!),
  }));

  app.post('/api/auth/change-password', { preHandler: requireAuth }, async (req) => {
    const body = ChangePasswordSchema.parse(req.body);
    const user = req.user!;
    if (!user.passwordHash)
      throw badRequest('You have no password here. Ask an admin to reset it to get one.');
    if (!(await verifyPassword(user.passwordHash, body.currentPassword)))
      throw badRequest('Current password is wrong');
    if (body.newPassword === body.currentPassword)
      throw badRequest('Choose a password different from the current one');
    assertPasswordPolicy(body.newPassword);
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), mustChangePassword: false })
      .where(eq(users.id, user.id));
    await deleteUserSessions(db, user.id, req.sessionId!);
    await audit(db, {
      actorUserId: user.id,
      actorIp: req.ip,
      action: 'password_changed',
      entityType: 'user',
      entityId: user.id,
      summary: `${user.email} changed their password`,
    });
    return { ok: true };
  });
}
