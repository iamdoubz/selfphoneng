// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

export const PASSWORD_MIN = 10;

export const LoginSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(), // M11
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(PASSWORD_MIN).max(200),
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
