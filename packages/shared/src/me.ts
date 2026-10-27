// SPDX-License-Identifier: AGPL-3.0-or-later
// GET/PATCH /api/me (04 §7.3): the signed-in user's own phone settings.
import { z } from 'zod';

/** What a person types for a forward: "101", "(312) 555-1234", "+44 20 …"; null = off. */
const ForwardInput = z
  .string()
  .trim()
  .max(40)
  .regex(/^[0-9*#+()\s.-]*[0-9][0-9*#+()\s.-]*$/, 'A number like 101 or (312) 555-1234')
  .nullable();

/** How often the call report email goes out (05 §4), in the company time zone. */
export const CALL_REPORTS = ['off', 'hourly', 'daily', 'weekly'] as const;
export type CallReport = (typeof CALL_REPORTS)[number];

export const MeUpdateSchema = z.object({
  dnd: z.boolean().optional(),
  /** Forward always / when busy / when not answered. */
  cfu: ForwardInput.optional(),
  cfb: ForwardInput.optional(),
  cfna: ForwardInput.optional(),
  voicemailEmail: z.boolean().optional(),
  voicemailAttachAudio: z.boolean().optional(),
  voicemailDeleteAfterEmail: z.boolean().optional(),
  voicemailPin: z
    .string()
    .regex(/^\d{4,10}$/, 'Use 4 to 10 digits')
    .optional(),
  callReport: z.enum(CALL_REPORTS).optional(),
  /** HH:MM, for daily and weekly. */
  callReportTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time like 08:00')
    .optional(),
  /** 0 = Sunday, for weekly. */
  callReportWeekday: z.number().int().min(0).max(6).optional(),
  /** Each recorded call's summary too (spec 10 §3). */
  callReportSummaries: z.boolean().optional(),
});
export type MeUpdate = z.input<typeof MeUpdateSchema>;

export type MeDto = {
  extension: { number: string; name: string };
  dnd: boolean;
  /** Stored normalized: an internal number, or an outside number like 13125551234. */
  cfu: string | null;
  cfb: string | null;
  cfna: string | null;
  voicemailEnabled: boolean;
  voicemailEmail: boolean;
  voicemailAttachAudio: boolean;
  voicemailDeleteAfterEmail: boolean;
  callReport: CallReport;
  callReportTime: string;
  callReportWeekday: number;
  callReportSummaries: boolean;
  /** Contacts in Contrack mode (11 §4.3): my token, never shown again; null in builtin mode. */
  contrack: {
    connected: boolean;
    tokenPrefix: string | null;
    publicUrl: string | null;
    /** 11 §4.4: my calls on my contacts' Contrack timelines, and with their summaries. */
    logCalls: boolean;
    logSummaries: boolean;
    /** Call summaries are on (Settings → AI), so logSummaries can do something. */
    summariesAvailable: boolean;
  } | null;
};

/** PATCH /api/me/contrack. */
export const ContrackOptionsSchema = z.object({
  logCalls: z.boolean().optional(),
  logSummaries: z.boolean().optional(),
});
export type ContrackOptions = z.input<typeof ContrackOptionsSchema>;

/** POST /api/mobile/pair (13 §2): the app trades a pairing code for its device token. */
export const MobilePairSchema = z.object({
  // Typed by hand from a screen: case and spaces don't matter.
  code: z
    .string()
    .transform((s) => s.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .pipe(z.string().length(12)),
  name: z.string().trim().min(1).max(100),
  platform: z.enum(['android', 'ios']),
});
export type MobilePair = z.input<typeof MobilePairSchema>;
export type MobilePairResult = { token: string; user: { name: string; email: string } };

/** POST /api/me/mobile-devices/pair: shown on the web as a QR code and as server + code. */
export type MobilePairCode = {
  code: string;
  server: string;
  link: string;
  qr: string;
  expiresAt: string;
};

export type MobileDeviceDto = {
  id: string;
  name: string;
  platform: 'android' | 'ios';
  /** "spm_AbC1", to recognize it. */
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** The device making this request. */
  current: boolean;
};
