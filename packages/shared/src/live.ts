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

export type LiveSnapshot = {
  extensions: ExtensionLive[];
  /** Admins only. */
  trunks?: TrunkLive[];
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
  /** Only to the mailbox owner. */
  | { type: 'voicemail.new'; data: VoicemailDto & { userId: string } }
  | { type: 'ami.status'; data: { connected: boolean } }
  | {
      type: 'system.configApplied';
      data: { ok: boolean; error: string | null; restartRequired: boolean };
    };
