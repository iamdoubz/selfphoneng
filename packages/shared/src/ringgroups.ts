// SPDX-License-Identifier: AGPL-3.0-or-later
// Ring groups (02 ring_groups, 03 §6.7): one number that rings several people.
import { z } from 'zod';
import { DestinationSchema, type Destination } from './destination.ts';
import { InternalNumber } from './extensions.ts';

export const RING_STRATEGIES = ['ringall', 'hunt'] as const;

const RingGroupFields = z.object({
  number: InternalNumber,
  name: z.string().trim().min(1, 'Required').max(40),
  /** ringall: everyone at once; hunt: one at a time, in member order. */
  strategy: z.enum(RING_STRATEGIES),
  /** Per member for hunt, total for ringall. */
  ringSeconds: z.number().int().min(5).max(300),
  /** Shown before the caller's name, e.g. "Sales: ". Same rules as caller ID names (03 §2). */
  callerIdNamePrefix: z
    .string()
    .max(20)
    .regex(/^[^"'\\;,()[\]{}$<>|]*$/, 'No quotes, commas, brackets or ; $ < > |')
    .nullable(),
  musicInsteadOfRing: z.boolean(),
  /** Extension ids, in ring order. */
  memberIds: z
    .array(z.uuid())
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Someone is listed twice'),
  noAnswerDestination: DestinationSchema,
});

export const RingGroupCreateSchema = RingGroupFields.partial().required({
  number: true,
  name: true,
  noAnswerDestination: true,
});
export const RingGroupUpdateSchema = RingGroupFields.partial();
export type RingGroupCreate = z.input<typeof RingGroupCreateSchema>;
export type RingGroupUpdate = z.input<typeof RingGroupUpdateSchema>;

export type RingGroupDto = z.output<typeof RingGroupFields> & {
  id: string;
  noAnswerDestination: Destination;
  noAnswerSummary: string;
  createdAt: string;
};
