// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

export const RoleSchema = z.enum(['admin', 'user']);

export const UserCreateSchema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(100),
  role: RoleSchema.default('user'),
});

export const UserUpdateSchema = z
  .object({
    email: z.email().max(254),
    displayName: z.string().trim().min(1).max(100),
    role: RoleSchema,
    isActive: z.boolean(),
  })
  .partial();

export type UserCreate = z.input<typeof UserCreateSchema>;
export type UserUpdate = z.input<typeof UserUpdateSchema>;

/** A user as the API returns it (no password hash, no TOTP secret). */
export type UserDto = {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'user';
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  extension: { id: string; number: string } | null;
};

export type ListResponse<T> = { items: T[]; nextCursor: string | null };
