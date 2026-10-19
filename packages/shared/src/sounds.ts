// SPDX-License-Identifier: AGPL-3.0-or-later
// Recorded prompts for IVRs, announcements and the recording notice (02 sound_files, 04 §6).
// Music-on-hold files are sound_files too (kind moh), listed per class (moh.ts).
import { z } from 'zod';

export const SoundName = z.string().trim().min(1, 'Required').max(80);
export const SoundUpdateSchema = z.object({ name: SoundName });
export type SoundUpdate = z.input<typeof SoundUpdateSchema>;

export type SoundDto = {
  id: string;
  name: string;
  /** What dialplan plays, e.g. custom/3f2a…; never shown to people. */
  asteriskName: string;
  durationMs: number;
  originalFilename: string | null;
  createdAt: string;
};

/** Upload limits shared by the page and the api (04 §6). */
export const SOUND_MAX_BYTES = 20 * 1024 * 1024;
