// SPDX-License-Identifier: AGPL-3.0-or-later
// "Where a call goes next" (spec 02 §1). Stored as jsonb in many tables.
import { z } from 'zod';

export const DestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), id: z.uuid() }), // extensions.id; rings, then that user's no-answer handling
  z.object({ type: z.literal('voicemail'), id: z.uuid() }), // extensions.id; straight to voicemail
  z.object({ type: z.literal('ring_group'), id: z.uuid() }),
  z.object({ type: z.literal('queue'), id: z.uuid() }),
  z.object({ type: z.literal('ivr'), id: z.uuid() }),
  z.object({ type: z.literal('time_condition'), id: z.uuid() }),
  z.object({ type: z.literal('conference'), id: z.uuid() }),
  z.object({ type: z.literal('announcement'), id: z.uuid() }),
  z.object({ type: z.literal('external'), number: z.string().regex(/^[0-9*#+]+$/) }), // normalized external number
  z.object({ type: z.literal('hangup') }),
]);

export type Destination = z.infer<typeof DestinationSchema>;
