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
};

/** The ways a user can sign in (12 §2): their password, a connected OpenID account, the directory. */
export type SignInWays = {
  password: boolean;
  oidc: { email: string | null } | null;
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
