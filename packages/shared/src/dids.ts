// SPDX-License-Identifier: AGPL-3.0-or-later
// Phone numbers (DIDs) as the API accepts and returns them (02, 04 §7.3, 05 §2).
import { z } from 'zod';
import { DestinationSchema } from './destination.ts';
import { normalizeNumber } from './phone.ts';

/** Any way of writing a number → its normalized digits (00 §8). */
export const DidNumber = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      const n = normalizeNumber(v);
      if (/^\d{7,15}$/.test(n)) return n;
    } catch {
      // reported below
    }
    ctx.addIssue({ code: 'custom', message: 'A phone number like (312) 555-1234' });
    return z.NEVER;
  });

const DidFields = z.object({
  number: DidNumber,
  trunkId: z.uuid('Pick a trunk'),
  label: z.string().trim().max(60).nullable(),
  destination: DestinationSchema,
  callerIdNamePrefix: z
    .string()
    .trim()
    .max(12)
    .regex(/^[A-Za-z0-9 :_.#-]*$/, 'Letters, digits, spaces and : _ . # - only')
    .nullable(),
  e911Address: z.string().trim().max(200).nullable(),
  /** Record every call to this number (callers hear the recording notice first, if set). */
  recordInbound: z.boolean(),
});

export const DidCreateSchema = DidFields.partial().required({
  number: true,
  trunkId: true,
  destination: true,
});
export const DidUpdateSchema = DidFields.partial();

export type DidCreate = z.input<typeof DidCreateSchema>;
export type DidUpdate = z.input<typeof DidUpdateSchema>;

export type DidDto = z.output<typeof DidFields> & {
  id: string;
  /** "Ring Dan Doe (101)", for lists. */
  destinationSummary: string;
  createdAt: string;
};
