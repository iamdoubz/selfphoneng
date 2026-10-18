// SPDX-License-Identifier: AGPL-3.0-or-later
// Live state shapes sent over the /api/live WebSocket (04 §5.1, §5.2).
import type { VoicemailDto } from './voicemail.ts';

export type ExtensionState =
  'idle' | 'inuse' | 'busy' | 'unavailable' | 'ringing' | 'onhold' | 'ringinuse';

export type ContactLive = {
  endpoint: string; // "101" or "101-web"
  uri: string;
  userAgent?: string;
  status: 'reachable' | 'unreachable' | 'unknown';
  rttMs?: number;
};

export type ExtensionLive = {
  number: string;
  name: string;
  state: ExtensionState;
  /** Admins only; users see presence without devices. */
  contacts?: ContactLive[];
  /** Any registered device (desk phone, app or browser). */
  online: boolean;
  dnd: boolean;
};

export type TrunkLive = {
  trunkId: string;
  /** Always 'unknown' for IP-auth trunks: they don't register. */
  registration: 'registered' | 'rejected' | 'unregistered' | 'unknown';
  /** The server answers OPTIONS (qualify). */
  reachable: boolean;
  lastChange: string;
};

/** 911 was dialed (or the notifications were tested). */
export type EmergencyCall = {
  ext: string;
  name: string;
  location: string | null;
  callerId: string;
  at: string;
  test: boolean;
  /** Non-admin users who get it too (their extension is a notify extension). */
  audienceUserIds: string[];
};

/** A call in progress (04 §5.1): every channel with the same Asterisk linkedid. */
export type ActiveCall = {
  linkedid: string;
  startedAt: string;
  answeredAt?: string;
  direction: 'inbound' | 'outbound' | 'internal';
  from: { number: string; name?: string };
  to: { number: string; name?: string };
  did?: string;
  state: 'ringing' | 'talking' | 'hold' | 'queued' | 'ivr' | 'voicemail' | 'parked';
  /** Internal numbers involved. */
  extensions: string[];
  /** Asterisk channel names (what `core show channels` lists). */
  channels: string[];
  recording: boolean;
};

export type LiveSnapshot = {
  extensions: ExtensionLive[];
  /** Admins only. */
  trunks?: TrunkLive[];
  /** Admins only. */
  calls?: ActiveCall[];
  /** Queues and parked calls arrive with M8. */
  queues?: never[];
  parked?: never[];
  ami: { connected: boolean };
};

/** Server → client messages. */
export type LiveMessage =
  | { type: 'snapshot'; data: LiveSnapshot }
  | { type: 'extension.updated'; data: ExtensionLive }
  | { type: 'extension.removed'; data: { number: string } }
  | { type: 'trunk.updated'; data: TrunkLive }
  | { type: 'trunk.removed'; data: { trunkId: string } }
  | { type: 'emergency.call'; data: EmergencyCall }
  /** Admins only. */
  | { type: 'call.updated'; data: ActiveCall }
  | { type: 'call.removed'; data: { linkedid: string } }
  /** Only to the mailbox owner. */
  | { type: 'voicemail.new'; data: VoicemailDto & { userId: string } }
  /** A short message for one user (e.g. "forwarding refused"). */
  | { type: 'toast'; data: { userId: string; message: string } }
  | { type: 'ami.status'; data: { connected: boolean } }
  | {
      type: 'system.configApplied';
      data: { ok: boolean; error: string | null; restartRequired: boolean };
    };
