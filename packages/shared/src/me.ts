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
};
