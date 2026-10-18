// SPDX-License-Identifier: AGPL-3.0-or-later
// Blocked callers (02 blocked_numbers): calls from these numbers are rejected at the trunk.
import { z } from 'zod';
import { normalizeNumber } from './phone.ts';

export const BlockedCreateSchema = z.object({
  /** Any format; stored normalized like incoming caller IDs (00 §8). */
  number: z
    .string()
    .trim()
    .min(1, 'Required')
    .transform((v, ctx) => {
      try {
        return normalizeNumber(v);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'A phone number like (312) 555-1234' });
        return z.NEVER;
      }
    }),
  reason: z.string().trim().max(100).nullable().optional(),
});
export type BlockedCreate = z.input<typeof BlockedCreateSchema>;

export type BlockedDto = { id: string; number: string; reason: string | null; createdAt: string };
