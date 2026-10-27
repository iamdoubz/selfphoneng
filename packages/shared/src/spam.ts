// SPDX-License-Identifier: AGPL-3.0-or-later
// Spam check (spec 14): what a check says about an outside caller, and its settings.
import { z } from 'zod';

export type SpamRisk = 'low' | 'medium' | 'high';
export type SpamProvider = 'ipqs' | 'ftc';

/** IPQualityScore's answer, only the fields 14 §2.1 keeps. */
export type IpqsInfo = {
  fraudScore: number;
  spammer: boolean;
  recentAbuse: boolean;
  lineType: string | null;
  carrier: string | null;
  name: string | null;
  city: string | null;
  region: string | null;
};

/** The FTC complaints in the window (14 §2.2). */
export type FtcInfo = {
  complaints: number;
  robocalls: number;
  lastReportedAt: string | null;
  subject: string | null;
};

export type SpamCheck =
  | { risk: SpamRisk; provider: 'ipqs'; info: IpqsInfo }
  | { risk: SpamRisk; provider: 'ftc'; info: FtcInfo };

/** The desk phone labels go through phoneSafeName (api), so only what it keeps. */
const label = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[\p{L}\p{M}\p{N} .'&@-]+$/u, "Letters, digits, spaces and . ' & @ - only")
  .transform((s) => s.replace(/ +/g, ' '));

export const SpamLabelsSchema = z.object({ high: label, medium: label });

export const SpamCacheSchema = z.object({
  flaggedDays: z.number().int().min(1).max(365),
  cleanDays: z.number().int().min(1).max(365),
});

/** The stored `spam` setting (14 §7). Keys encrypted; a null provider isn't used. */
export const SpamSettingsSchema = z.object({
  enabled: z.boolean(),
  ipqs: z.object({ keyEnc: z.string() }).nullable(),
  ftc: z
    .object({
      keyEnc: z.string(),
      syncHours: z.number().int().min(1).max(168),
      windowDays: z.number().int().min(7).max(365),
    })
    .nullable(),
  cache: SpamCacheSchema,
  deskPhoneLabels: SpamLabelsSchema,
});
export type SpamSettings = z.infer<typeof SpamSettingsSchema>;

export const SPAM_DEFAULTS: SpamSettings = {
  enabled: false,
  ipqs: null,
  ftc: null,
  cache: { flaggedDays: 14, cleanDays: 3 },
  deskPhoneLabels: { high: 'SPAM LIKELY', medium: 'Spam risk' },
};

/** What the system keeps about the providers (`spam.state`, read-only to PATCH). */
export const SpamStateSchema = z.object({
  ipqsPausedAt: z.string().nullable().default(null),
  warningDismissedAt: z.string().nullable().default(null),
  ftcSyncedTo: z.string().nullable().default(null),
  ftcCursor: z.number().int().nullable().default(null),
  ftcLastSyncAt: z.string().nullable().default(null),
  ftcLastError: z.string().nullable().default(null),
});
export type SpamState = z.infer<typeof SpamStateSchema>;

/** PATCH /api/settings `spam`: keys are write-only (empty keeps the stored one). */
export const SpamInputSchema = z.object({
  enabled: z.boolean(),
  ipqs: z.object({ key: z.string().trim().max(200).optional() }).nullable(),
  ftc: z
    .object({
      key: z.string().trim().max(200).optional(),
      syncHours: z.number().int().min(1).max(168),
      windowDays: z.number().int().min(7).max(365),
    })
    .nullable(),
  cache: SpamCacheSchema,
  deskPhoneLabels: SpamLabelsSchema,
});
export type SpamInput = z.input<typeof SpamInputSchema>;

/** GET /api/settings `spam`: keys replaced by hasKey. */
export type SpamSettingsDto = Omit<SpamSettings, 'ipqs' | 'ftc'> & {
  ipqs: { hasKey: boolean } | null;
  ftc: { hasKey: boolean; syncHours: number; windowDays: number } | null;
};

/** POST /api/settings/spam/{ipqs,ftc}/test. */
export type SpamTestResult = { ok: true; detail: string } | { ok: false; error: string };
