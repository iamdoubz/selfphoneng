// SPDX-License-Identifier: AGPL-3.0-or-later
// Live data from /api/live (05 §1): one WebSocket per tab, reconnecting with backoff.
import { create } from 'zustand';
import type {
  ActiveCall,
  EmergencyCall,
  ExtensionLive,
  LiveMessage,
  QueueLive,
  TrunkLive,
} from '@selfphoneng/shared';

type LiveStore = {
  /** WebSocket state: 'connecting' before the first snapshot. */
  status: 'connecting' | 'open' | 'reconnecting';
  amiConnected: boolean;
  extensions: Record<string, ExtensionLive>;
  /** Admins only (empty for users). */
  trunks: Record<string, TrunkLive>;
  /** Admins only: calls in progress by linkedid. */
  calls: Record<string, ActiveCall>;
  /** By number. Admins: all; users: the queues they're an agent of. */
  queues: Record<string, QueueLive>;
  /** 911 alerts received while this tab was open, newest last; dismissed ones are removed. */
  emergencies: EmergencyCall[];
  /** Bumped on every voicemail.new, so the voicemail list knows to refetch. */
  voicemailSeq: number;
  /** Short messages for this user (e.g. forwarding refused); dismissed ones are removed. */
  toasts: { id: number; message: string }[];
};

export const useLive = create<LiveStore>(() => ({
  status: 'connecting',
  amiConnected: false,
  extensions: {},
  trunks: {},
  calls: {},
  queues: {},
  emergencies: [],
  voicemailSeq: 0,
  toasts: [],
}));

function apply(m: LiveMessage) {
  useLive.setState((s) => {
    switch (m.type) {
      case 'snapshot':
        return {
          status: 'open',
          amiConnected: m.data.ami.connected,
          extensions: Object.fromEntries(m.data.extensions.map((e) => [e.number, e])),
          trunks: Object.fromEntries((m.data.trunks ?? []).map((t) => [t.trunkId, t])),
          calls: Object.fromEntries((m.data.calls ?? []).map((c) => [c.linkedid, c])),
          queues: Object.fromEntries(m.data.queues.map((q) => [q.number, q])),
        };
      case 'extension.updated':
        return { extensions: { ...s.extensions, [m.data.number]: m.data } };
      case 'extension.removed': {
        const { [m.data.number]: _gone, ...rest } = s.extensions;
        return { extensions: rest };
      }
      case 'trunk.updated':
        return { trunks: { ...s.trunks, [m.data.trunkId]: m.data } };
      case 'trunk.removed': {
        const { [m.data.trunkId]: _gone, ...rest } = s.trunks;
        return { trunks: rest };
      }
      case 'call.updated':
        return { calls: { ...s.calls, [m.data.linkedid]: m.data } };
      case 'call.removed': {
        const { [m.data.linkedid]: _gone, ...rest } = s.calls;
        return { calls: rest };
      }
      case 'queue.updated':
        return { queues: { ...s.queues, [m.data.number]: m.data } };
      case 'queue.removed': {
        const { [m.data.number]: _gone, ...rest } = s.queues;
        return { queues: rest };
      }
      case 'emergency.call':
        return { emergencies: [...s.emergencies, m.data] };
      case 'toast':
        return { toasts: [...s.toasts, { id: Date.now(), message: m.data.message }] };
      case 'voicemail.new':
        return { voicemailSeq: s.voicemailSeq + 1 };
      case 'ami.status':
        return { amiConnected: m.data.connected };
      default:
        return {};
    }
  });
}

const BACKOFF = [1, 2, 4, 8, 16, 30].map((s) => s * 1000);
let socket: WebSocket | null = null;
let users = 0;
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | undefined;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/live`);
  socket = ws;
  ws.onmessage = (ev) => {
    attempt = 0;
    apply(JSON.parse(ev.data as string) as LiveMessage);
  };
  ws.onclose = (ev) => {
    if (socket !== ws || users === 0) return;
    socket = null;
    if (ev.code === 4401) return; // signed out: the auth gate redirects to /login
    useLive.setState({ status: 'reconnecting' });
    retry = setTimeout(connect, BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
  };
}

/** Pages that show live data call this in an effect; the socket closes when nobody needs it. */
export function subscribeLive(): () => void {
  if (users++ === 0) connect();
  return () => {
    if (--users > 0) return;
    clearTimeout(retry);
    const ws = socket;
    socket = null;
    ws?.close();
    useLive.setState({ status: 'connecting' });
  };
}
