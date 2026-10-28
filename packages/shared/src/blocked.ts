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
  reason: z.string().trim().max(200).nullable().optional(),
});
export type BlockedCreate = z.input<typeof BlockedCreateSchema>;

export type BlockedDto = { id: string; number: string; reason: string | null; createdAt: string };

/**
 * A user's "Report spam" on a call that rang them (05 §4). The reason is the spam check's line
 * when it flagged the call, else what the user typed. An admin blocks or dismisses it.
 */
export const SpamReportCreateSchema = z.object({
  callId: z.uuid(),
  reason: z.string().trim().min(1, 'Say why').max(200),
});
export type SpamReportCreate = z.input<typeof SpamReportCreateSchema>;

export type SpamReportDto = {
  id: string;
  number: string;
  reason: string;
  /** The reporter's display name; null once their account is gone. */
  reportedBy: string | null;
  createdAt: string;
};
