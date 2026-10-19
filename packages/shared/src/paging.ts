// SPDX-License-Identifier: AGPL-3.0-or-later
// Paging groups (02 paging_groups, 03 §6.11): a number that makes several desk phones answer by
// themselves and play what the caller says.
import { z } from 'zod';
import { InternalNumber } from './extensions.ts';

const PagingGroupFields = z.object({
  number: InternalNumber,
  name: z.string().trim().min(1, 'Required').max(40),
  /** false: one-way announcement; true: intercom, the paged phones can talk back. */
  duplex: z.boolean(),
  /** Extension ids. */
  memberIds: z
    .array(z.uuid())
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Someone is listed twice'),
});

export const PagingGroupCreateSchema = PagingGroupFields.partial().required({
  number: true,
  name: true,
});
export const PagingGroupUpdateSchema = PagingGroupFields.partial();
export type PagingGroupCreate = z.input<typeof PagingGroupCreateSchema>;
export type PagingGroupUpdate = z.input<typeof PagingGroupUpdateSchema>;

export type PagingGroupDto = z.output<typeof PagingGroupFields> & { id: string; createdAt: string };
