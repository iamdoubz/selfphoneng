// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

export const PASSWORD_MIN = 10;

export const LoginSchema = z.object({
  email: z.string().trim().min(3, 'Enter your email').max(254),
  password: z.string().min(1, 'Enter your password').max(200),
  /** The authenticator code, or a recovery code ("k7m3q-x9tpw"), when two-step sign-in is on. */
  totp: z.string().trim().max(20).optional(),
});

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
};

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
