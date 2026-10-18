// SPDX-License-Identifier: AGPL-3.0-or-later
// Call history (02 calls, call_extensions; 04 §5.4, §7.3).
import { z } from 'zod';

export const CALL_DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export const CALL_STATUSES = [
  'answered',
  'missed',
  'voicemail',
  'abandoned',
  'busy',
  'failed',
] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];
export type CallStatus = (typeof CALL_STATUSES)[number];

/** GET /api/calls and /api/calls/export.csv. Dates are YYYY-MM-DD in the company time zone. */
export const CallFilterSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  direction: z.enum(CALL_DIRECTIONS).optional(),
  status: z.enum(CALL_STATUSES).optional(),
  extensionId: z.uuid().optional(),
  didId: z.uuid().optional(),
  /** Part of a number (digits only are compared). */
  q: z.string().trim().max(40).optional(),
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CallFilter = z.input<typeof CallFilterSchema>;

export type CallDto = {
  id: string;
  direction: CallDirection;
  status: CallStatus;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string;
  fromNumber: string | null;
  fromName: string | null;
  toNumber: string | null;
  did: { id: string; number: string; label: string | null } | null;
  answeredBy: { id: string; number: string; name: string } | null;
  talkSeconds: number;
  recordingId: string | null;
};

/** One raw CDR leg, for the expanded row. */
export type CallLegDto = {
  startAt: string | null;
  channel: string | null;
  dstchannel: string | null;
  lastapp: string | null;
  disposition: string | null;
  billsec: number | null;
};

export type CallDetailDto = CallDto & { legs: CallLegDto[]; linkedid: string };

/** /api/me/calls: my part in it. */
export type MyCallDto = CallDto & {
  /** in = someone called me (or I was rung), out = I called. */
  myRole: 'in' | 'out';
  /** Someone called me and nobody answered (a colleague answering in a group isn't missed). */
  missedByMe: boolean;
};

export type RecordingDto = {
  id: string;
  startedAt: string;
  durationMs: number | null;
  sizeBytes: number | null;
  call: {
    id: string;
    direction: CallDirection;
    fromNumber: string | null;
    fromName: string | null;
    toNumber: string | null;
  } | null;
};
