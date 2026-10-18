// SPDX-License-Identifier: AGPL-3.0-or-later
// Announcements (02 announcements, 03 §6.11): play a sound, then send the caller on.
import { z } from 'zod';
import { DestinationSchema, type Destination } from './destination.ts';

const AnnouncementFields = z.object({
  name: z.string().trim().min(1, 'Required').max(40),
  soundId: z.uuid('Pick a sound'),
  destination: DestinationSchema,
});

export const AnnouncementCreateSchema = AnnouncementFields;
export const AnnouncementUpdateSchema = AnnouncementFields.partial();
export type AnnouncementCreate = z.input<typeof AnnouncementCreateSchema>;
export type AnnouncementUpdate = z.input<typeof AnnouncementUpdateSchema>;

export type AnnouncementDto = z.output<typeof AnnouncementFields> & {
  id: string;
  destination: Destination;
  destinationSummary: string;
  soundName: string;
};
