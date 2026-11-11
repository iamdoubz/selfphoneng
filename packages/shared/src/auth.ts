// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

export const PASSWORD_MIN = 10;

/** The login form's fields: `login` is an email, or a directory username (12 §4.2). */
export const LoginFields = z.object({
  login: z.string().trim().min(1, 'Enter your email').max(254),
  password: z.string().min(1, 'Enter your password').max(200),
  /** The authenticator code, or a recovery code ("k7m3q-x9tpw"), when two-step sign-in is on. */
  totp: z.string().trim().max(20).optional(),
});

/** POST /api/auth/login. `email`, the field's name before 12, is still accepted. */
export const LoginSchema = z.preprocess(
  (v) =>
    v && typeof v === 'object' && !('login' in v) && 'email' in v ? { ...v, login: v.email } : v,
  LoginFields,
);

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(200),
  newPassword: z
    .string()
    .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
    .max(200, 'Use at most 200 characters'),
});

export type Role = 'admin' | 'user';

/** What /api/auth/login and /api/auth/me return. */
export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
  extension: { id: string; number: string; name: string } | null;
  signIn: SignInWays;
  /** My photo (11 §8), or null. */
  photo: string | null;
};

/** The ways a user can sign in (12 §2): their password, a connected OpenID account, the directory. */
export type SignInWays = {
  password: boolean;
  /** `groups`: what the provider sent at the last sign-in (12 §3.4), to copy into Settings. */
  oidc: { email: string | null; groups: string[] } | null;
  ldap: boolean;
};

/** 12 §1.1: which ways the login page offers. */
export type AuthMode = 'password' | 'mixed' | 'oidc';

/** GET /api/auth/methods (public): what the login page shows. */
export type AuthMethods = { mode: AuthMode; ldap: boolean; oidc: { label: string } | null };

/** Two-step sign-in (TOTP, 08 §2.4) for the signed-in user. */
export type TotpStatus = { enabled: boolean; recoveryCodesLeft: number };
/** Start: the secret to scan (not stored until a code confirms it). */
export type TotpSetup = { secret: string; otpauthUrl: string; qr: string };
export const TotpEnableSchema = z.object({
  secret: z.string().regex(/^[A-Z2-7]{32}$/),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'The 6-digit code from the app'),
  password: z.string().min(1).max(200),
});
export const PasswordConfirmSchema = z.object({ password: z.string().min(1).max(200) });

/** Passkeys (15). Binary values travel as base64url. */
const B64U = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(4096);
export type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
/** POST /api/auth/passkeys/options: what navigator.credentials.create needs. */
export type PasskeyCreateOptions = {
  challenge: string;
  rpId: string;
  rpName: string;
  user: { id: string; name: string; displayName: string };
  algs: number[];
  /** Credential ids this person already has here: the device won't make a second one. */
  exclude: string[];
};
/** POST /api/auth/passkey/options (public): what navigator.credentials.get needs. */
export type PasskeyLoginOptions = { challenge: string; rpId: string };
export const PasskeyAddSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name').max(60),
  password: z.string().min(1).max(200),
  id: B64U,
  clientDataJSON: B64U,
  authenticatorData: B64U,
  publicKey: B64U,
  alg: z.number().int(),
});
export const PasskeyLoginSchema = z.object({
  id: B64U,
  clientDataJSON: B64U,
  authenticatorData: B64U,
  signature: B64U,
});
