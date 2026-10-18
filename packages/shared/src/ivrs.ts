// SPDX-License-Identifier: AGPL-3.0-or-later
// Digital receptionist / IVR (02 ivrs, ivr_options, 03 §6.9): "press 1 for sales…".
import { z } from 'zod';
import { DestinationSchema, type Destination } from './destination.ts';
import { InternalNumber } from './extensions.ts';

export const IVR_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;

const IvrFields = z.object({
  number: InternalNumber,
  name: z.string().trim().min(1, 'Required').max(40),
  greetingSoundId: z.uuid('Pick a greeting'),
  /** null = the stock "that's not a valid choice" (pbx-invalid). */
  invalidSoundId: z.uuid().nullable(),
  timeoutSeconds: z.number().int().min(1).max(30),
  maxRetries: z.number().int().min(1).max(10),
  /** Callers may dial an internal number (e.g. 101) instead of pressing an option. */
  allowDirectDial: z.boolean(),
  options: z
    .array(z.object({ digit: z.enum(IVR_DIGITS), destination: DestinationSchema }))
    .max(12)
    .refine((o) => new Set(o.map((x) => x.digit)).size === o.length, 'A key is used twice'),
  timeoutDestination: DestinationSchema,
  invalidDestination: DestinationSchema,
});

export const IvrCreateSchema = IvrFields.partial().required({
  number: true,
  name: true,
  greetingSoundId: true,
  timeoutDestination: true,
  invalidDestination: true,
});
export const IvrUpdateSchema = IvrFields.partial();
export type IvrCreate = z.input<typeof IvrCreateSchema>;
export type IvrUpdate = z.input<typeof IvrUpdateSchema>;

export type IvrDto = Omit<z.output<typeof IvrFields>, 'options'> & {
  id: string;
  options: { digit: (typeof IVR_DIGITS)[number]; destination: Destination; summary: string }[];
  createdAt: string;
};
