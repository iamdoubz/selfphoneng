// SPDX-License-Identifier: AGPL-3.0-or-later
// Extension (the telephony identity of a user) as the API accepts and returns it (02, 04 §7.3).
// The patterns match the generator's sanitizers (03 §2), so valid input always renders.
import { z } from 'zod';

/** 1 to 6 digits (owner, 2026-10-21: "1" for the first user; the generator's patterns are _X!). */
export const InternalNumber = z.string().regex(/^\d{1,6}$/, 'Use 1 to 6 digits');
const Slug = z.string().regex(/^[a-z0-9-]{1,32}$/, 'Lowercase letters, digits and dashes');
const Pin = z.string().regex(/^\d{4,10}$/, 'Use 4 to 10 digits');

const ExtensionFields = z.object({
  number: InternalNumber,
  userId: z.uuid().nullable(),
  name: z.string().trim().min(1, 'Required').max(40),
  webrtcEnabled: z.boolean(),
  maxContacts: z.number().int().min(1).max(10),
  ringSeconds: z.number().int().min(5).max(120),
  voicemailEnabled: z.boolean(),
  voicemailPin: Pin, // write-only
  voicemailEmail: z.boolean(),
  voicemailAttachAudio: z.boolean(),
  voicemailDeleteAfterEmail: z.boolean(),
  outboundClass: z.enum(['internal', 'local', 'national', 'international']),
  outboundCallerIdDidId: z.uuid().nullable(),
  emergencyCallerIdDidId: z.uuid().nullable(),
  emergencyLocation: z.string().trim().max(200).nullable(),
  recordMode: z.enum(['never', 'inbound', 'outbound', 'all']),
  pickupGroup: Slug.nullable(),
  language: z.string().regex(/^[a-z]{2,3}$/, 'A language code like en'),
  mohClass: Slug,
  blfNumbers: z.array(InternalNumber).max(32),
});

export const ExtensionCreateSchema = ExtensionFields.partial().required({
  number: true,
  name: true,
});
export const ExtensionUpdateSchema = ExtensionFields.partial();

export type ExtensionCreate = z.input<typeof ExtensionCreateSchema>;
export type ExtensionUpdate = z.input<typeof ExtensionUpdateSchema>;

export type ExtensionDto = Omit<z.output<typeof ExtensionFields>, 'voicemailPin'> & {
  id: string;
  createdAt: string;
};

export type SipCredentials = {
  server: string;
  port: number;
  transport: 'udp' | 'tcp';
  username: string;
  password: string;
  /** Browser softphone identity (when webrtc is on). */
  webUsername: string | null;
};

/** GET /api/me/webrtc: what the browser softphone registers with (05 §5.2). */
export type WebRtcCreds = {
  wsUrl: string;
  sipUri: string;
  authUser: string;
  password: string;
  displayName: string;
  iceServers: { urls: string; username?: string; credential?: string }[];
};

export const NUMBER_KINDS = ['user', 'ringGroup', 'queue', 'ivr', 'conference', 'paging'] as const;
export type NumberKind = (typeof NUMBER_KINDS)[number];

/** Linphone setup (07 §5): the link the app fetches, as a QR (PNG data URL). Valid 24 h. */
export type SoftphoneQr = { url: string; qr: string; expiresAt: string };
