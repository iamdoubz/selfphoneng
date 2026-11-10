// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/auth/* (04 §2, §7.3).
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ChangePasswordSchema,
  LoginSchema,
  PasskeyAddSchema,
  PasskeyLoginSchema,
  PasswordConfirmSchema,
  TotpEnableSchema,
  APP_NAME,
  type AuthMethods,
  type AuthUser,
  type Passkey,
  type PasskeyCreateOptions,
  type PasskeyLoginOptions,
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
import {
  newChallenge,
  PASSKEY_ALGS,
  PasskeyError,
  verifyAssertion,
  verifyRegistration,
} from '../auth/passkeys.ts';
import type { Db } from '../db/client.ts';
import { extensions, passkeys, sessions, userIdentities, users } from '../db/schema.ts';
import { endSessionUrl, oidcError } from '../sso/oidc.ts';
import { directorySignIn, directoryWarning } from '../sso/directory.ts';
import { ldapAuthenticate } from '../sso/ldap.ts';
import { getSetting } from '../services/settings.ts';
import {
  unauthorized,
  rateLimited,
  badRequest,
  conflict,
  forbidden,
  notFound,
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

  /**
   * A signed-in person's own password, asked again (two-step on/off, recovery codes, a new
   * password). Wrong ones count in the login limiter, so a stolen session can't guess it.
   */
  async function myPasswordOk(req: FastifyRequest, hash: string | null, password: string) {
    if (isLoginBlocked(req.ip, req.user!.email)) throw rateLimited();
    if (hash && (await verifyPassword(hash, password))) return true;
    recordLoginFailure(req.ip, req.user!.email);
    return false;
  }

  app.post('/api/auth/totp/enable', { preHandler: requireAuth }, async (req) => {
    adminOnly(req.user!);
    const { secret, code, password } = TotpEnableSchema.parse(req.body);
    const u = await myRow(req.user!.id);
    if (u.totpSecretEnc) throw conflict('Two-step sign-in is already on');
    // Like turning it off: a stolen session alone can't lock the owner out with its own secret.
    if (!(await myPasswordOk(req, u.passwordHash, password))) throw badRequest('Wrong password');
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
  async function confirmPassword(req: FastifyRequest) {
    const { password } = PasswordConfirmSchema.parse(req.body);
    const u = await myRow(req.user!.id);
    if (!(await myPasswordOk(req, u.passwordHash, password))) throw badRequest('Wrong password');
    return u;
  }

  app.post('/api/auth/totp/disable', { preHandler: requireAuth }, async (req) => {
    await confirmPassword(req);
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
    const u = await confirmPassword(req);
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
      ldap: Boolean((await getSetting(db, 'auth.ldap'))?.enabled),
      oidc: oidc && mode !== 'password' ? { label: oidc.label } : null,
    };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { login, ...body } = LoginSchema.parse(req.body);
    if (isLoginBlocked(req.ip, login)) throw rateLimited();
    let [user] = await db.select().from(users).where(eq(users.email, login));
    // No password (OpenID only, 12 §3.3) fails like a wrong one, after the same work.
    let ok = user?.passwordHash
      ? await verifyPassword(user.passwordHash, body.password)
      : (await burnVerify(body.password), false);
    let method: 'password' | 'ldap' = 'password';
    // Not this password here: the directory's, when it's on (12 §4.2).
    const ldap = ok ? null : await getSetting(db, 'auth.ldap');
    if (ldap?.enabled) {
      let entry;
      try {
        entry = await ldapAuthenticate(ldap, login, body.password);
      } catch (err) {
        // Counted like a wrong password: a 503 must not be a free guess at the local one.
        recordLoginFailure(req.ip, login);
        await audit(db, {
          actorUserId: user?.id,
          actorIp: req.ip,
          action: 'login_failed',
          entityType: 'user',
          entityId: user?.id,
          summary: `Failed login for ${login} (the directory can't be reached)`,
        });
        req.log.warn({ event: 'auth.ldap', err: (err as Error).message }, 'directory unavailable');
        await directoryWarning(
          db,
          `A directory sign-in failed: the directory couldn't be reached (${(err as Error).message}).`,
        );
        throw new HttpError(
          503,
          'directory_unavailable',
          'The directory can’t be reached. Passwords set in SelfPhoneNG still work.',
        );
      }
      const found = entry && (await directorySignIn(db, req.log, entry, req.ip));
      if (entry && !found)
        req.log.warn({ event: 'auth.failed', ip: req.ip }, 'directory account has no user here');
      if (found) [user, ok, method] = [found, true, 'ldap'];
    }
    if (!user || !ok || !user.isActive) {
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
    const token = await createSession(
      db,
      user.id,
      req.ip,
      req.headers['user-agent'] ?? null,
      method,
    );
    setSessionCookie(reply, token);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await audit(db, {
      actorUserId: user.id,
      actorIp: req.ip,
      action: 'login',
      entityType: 'user',
      entityId: user.id,
      summary: `${user.email} logged in${method === 'ldap' ? ' with the directory' : ''}`,
    });
    return { user: await toAuthUser(db, user) };
  });

  // ───────────── passkeys (15) ─────────────
  const b64u = (v: string) => Buffer.from(v, 'base64url');
  /** The browser's origin and WebAuthn's site id: the public name, without a port for the id. */
  const site = {
    origin: `https://${app.config.PUBLIC_HOSTNAME}`,
    rpId: app.config.PUBLIC_HOSTNAME.replace(/:\d+$/, ''),
  };
  const MAX_PASSKEYS = 10;
  const myPasskeys = (userId: string) =>
    db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(asc(passkeys.createdAt));

  app.get('/api/auth/passkeys', { preHandler: requireAuth }, async (req) => {
    const items: Passkey[] = (await myPasskeys(req.user!.id)).map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt.toISOString(),
      lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    }));
    return { items };
  });

  app.post(
    '/api/auth/passkeys/options',
    { preHandler: requireAuth },
    async (req): Promise<PasskeyCreateOptions> => {
      const u = req.user!;
      return {
        challenge: newChallenge(u.id),
        rpId: site.rpId,
        rpName: APP_NAME,
        user: { id: u.id, name: u.email, displayName: u.displayName },
        algs: PASSKEY_ALGS,
        exclude: (await myPasskeys(u.id)).map((p) => p.credentialId),
      };
    },
  );

  app.post('/api/auth/passkeys', { preHandler: requireAuth }, async (req) => {
    const body = PasskeyAddSchema.parse(req.body);
    const u = await myRow(req.user!.id);
    // Like two-step sign-in: a stolen session alone can't add its own way back in (15 §1).
    if (!u.passwordHash)
      throw badRequest('You have no password here. Ask an admin to reset it to get one.');
    if (!(await myPasswordOk(req, u.passwordHash, body.password)))
      throw badRequest('Wrong password');
    if ((await myPasskeys(u.id)).length >= MAX_PASSKEYS)
      throw conflict(`You have ${MAX_PASSKEYS} passkeys already. Remove one first.`);
    let cred;
    try {
      cred = verifyRegistration(
        {
          id: b64u(body.id),
          clientDataJSON: b64u(body.clientDataJSON),
          authenticatorData: b64u(body.authenticatorData),
          publicKey: b64u(body.publicKey),
          alg: body.alg,
        },
        site,
        u.id,
      );
    } catch (err) {
      if (!(err instanceof PasskeyError)) throw err;
      req.log.warn({ event: 'auth.passkey', why: err.message }, 'passkey not added');
      throw badRequest('That passkey couldn’t be added. Try again.');
    }
    const [row] = await db
      .insert(passkeys)
      .values({ userId: u.id, name: body.name, ...cred })
      .onConflictDoNothing()
      .returning({ id: passkeys.id });
    if (!row) throw conflict('That passkey is already added.');
    await audit(db, {
      actorUserId: u.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'passkey',
      entityId: row.id,
      summary: `${u.email} added the passkey "${body.name}"`,
    });
    return { id: row.id };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/auth/passkeys/:id',
    { preHandler: requireAuth },
    async (req) => {
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound();
      const [row] = await db
        .delete(passkeys)
        .where(and(eq(passkeys.id, req.params.id), eq(passkeys.userId, req.user!.id)))
        .returning({ name: passkeys.name });
      if (!row) throw notFound();
      await audit(db, {
        actorUserId: req.user!.id,
        actorIp: req.ip,
        action: 'delete',
        entityType: 'passkey',
        entityId: req.params.id,
        summary: `${req.user!.email} removed the passkey "${row.name}"`,
      });
      return { ok: true };
    },
  );

  /** Public, and the same for everyone: a passkey names its own user (no email typed). */
  app.post('/api/auth/passkey/options', async (): Promise<PasskeyLoginOptions> => ({
    challenge: newChallenge(null),
    rpId: site.rpId,
  }));

  app.post('/api/auth/passkey/login', async (req, reply) => {
    const body = PasskeyLoginSchema.parse(req.body);
    // No login name to count by: failures count per address only, like the OpenID callback.
    if (isLoginBlocked(req.ip, null)) throw rateLimited();
    const [found] = await db
      .select({ passkey: passkeys, user: users })
      .from(passkeys)
      .innerJoin(users, eq(users.id, passkeys.userId))
      .where(eq(passkeys.credentialId, body.id));
    let signCount: number | null = null;
    let why = 'unknown passkey';
    if (found)
      try {
        signCount = verifyAssertion(
          {
            clientDataJSON: b64u(body.clientDataJSON),
            authenticatorData: b64u(body.authenticatorData),
            signature: b64u(body.signature),
          },
          found.passkey,
          site,
        );
      } catch (err) {
        if (!(err instanceof PasskeyError)) throw err;
        why = err.message;
      }
    if (!found || signCount === null || !found.user.isActive) {
      recordLoginFailure(req.ip, null);
      req.log.warn({ event: 'auth.failed', ip: req.ip, why }, 'passkey login failed');
      await audit(db, {
        actorUserId: found?.user.id,
        actorIp: req.ip,
        action: 'login_failed',
        entityType: 'user',
        entityId: found?.user.id,
        summary: `Failed passkey login${found ? ` for ${found.user.email}` : ''}`,
      });
      throw unauthorized('That passkey didn’t work here');
    }
    const { user, passkey } = found;
    // OpenID only (12 §1.1): like the password, a passkey is then for admins.
    if (user.role !== 'admin' && (await getSetting(db, 'auth.mode')) === 'oidc')
      throw forbidden('Use the sign-in button instead', 'password_sign_in_off');
    const now = new Date();
    await db
      .update(passkeys)
      .set({ signCount, lastUsedAt: now })
      .where(eq(passkeys.id, passkey.id));
    const token = await createSession(
      db,
      user.id,
      req.ip,
      req.headers['user-agent'] ?? null,
      'passkey',
    );
    setSessionCookie(reply, token);
    await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
    await audit(db, {
      actorUserId: user.id,
      actorIp: req.ip,
      action: 'login',
      entityType: 'user',
      entityId: user.id,
      summary: `${user.email} logged in with the passkey "${passkey.name}"`,
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
    if (!(await myPasswordOk(req, user.passwordHash, body.currentPassword)))
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
