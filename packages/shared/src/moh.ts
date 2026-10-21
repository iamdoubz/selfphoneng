// SPDX-License-Identifier: AGPL-3.0-or-later
// Music-on-hold classes (02 moh_classes, 03 §8): a named folder of music. 'default' is built in
// (the stock opsound files) and not stored.
import { z } from 'zod';
import type { SoundDto } from './sounds.ts';

/** Also the folder name under the MOH dir, so: a slug. */
export const MohClassName = z
  .string()
  .regex(/^[a-z0-9-]{1,32}$/, 'Lowercase letters, digits and dashes')
  .refine((n) => n !== 'default', '"default" is the built-in music');
export const MohClassCreateSchema = z.object({ name: MohClassName });
export type MohClassCreate = z.input<typeof MohClassCreateSchema>;
/** PATCH: shuffle, and/or the play order as every file id of the class, first to last. */
export const MohClassUpdateSchema = z.object({
  shuffle: z.boolean().optional(),
  order: z.array(z.uuid()).max(500).optional(),
});
export type MohClassUpdate = z.input<typeof MohClassUpdateSchema>;

export type MohClassDto = {
  id: string;
  name: string;
  /** Random order; otherwise `files` is the play order. */
  shuffle: boolean;
  files: Omit<SoundDto, 'asteriskName'>[];
  createdAt: string;
};
