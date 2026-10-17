// SPDX-License-Identifier: AGPL-3.0-or-later
// Live state shapes sent over the /api/live WebSocket (04 §5.1, §5.2).

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

export type LiveSnapshot = {
  extensions: ExtensionLive[];
  ami: { connected: boolean };
};

/** Server → client messages. */
export type LiveMessage =
  | { type: 'snapshot'; data: LiveSnapshot }
  | { type: 'extension.updated'; data: ExtensionLive }
  | { type: 'extension.removed'; data: { number: string } }
  | { type: 'ami.status'; data: { connected: boolean } }
  | {
      type: 'system.configApplied';
      data: { ok: boolean; error: string | null; restartRequired: boolean };
    };
