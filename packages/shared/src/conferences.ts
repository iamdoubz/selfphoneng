// SPDX-License-Identifier: AGPL-3.0-or-later
// Conference rooms (02 conferences, 03 §6.11): a number people dial to talk together.
import { z } from 'zod';
import { InternalNumber } from './extensions.ts';

const Pin = z.string().regex(/^[0-9]{4,10}$/, '4 to 10 digits');

const ConferenceFields = z.object({
  number: InternalNumber,
  name: z.string().trim().min(1, 'Required').max(40),
  /** null = anyone who dials the number gets in. */
  pin: Pin.nullable(),
  /** Callers who enter it join as the room's admin (marked user: can kick, mute others). */
  adminPin: Pin.nullable(),
  maxMembers: z.number().int().min(2).max(100),
  /** Every caller's leg is recorded, like a recorded call (call history, Recordings). */
  record: z.boolean(),
});

const pinsMakeSense = (c: { pin?: string | null; adminPin?: string | null }) =>
  !c.adminPin || (!!c.pin && c.pin !== c.adminPin);
const PINS_MESSAGE = {
  message: 'An admin PIN needs a (different) room PIN',
  path: ['adminPin'],
};

export const ConferenceCreateSchema = ConferenceFields.partial()
  .required({ number: true, name: true })
  .refine(pinsMakeSense, PINS_MESSAGE);
/** The route checks the PINs again against what is stored. */
export const ConferenceUpdateSchema = ConferenceFields.partial();
export type ConferenceCreate = z.input<typeof ConferenceCreateSchema>;
export type ConferenceUpdate = z.input<typeof ConferenceUpdateSchema>;

/** Admins see the PINs: they hand them out. */
export type ConferenceDto = z.output<typeof ConferenceFields> & { id: string; createdAt: string };

export { pinsMakeSense as conferencePinsMakeSense };
