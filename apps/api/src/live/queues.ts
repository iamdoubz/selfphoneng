// SPDX-License-Identifier: AGPL-3.0-or-later
// Queues right now (04 §5.1): waiting callers and agents. Loaded from QueueStatus on connect and
// after config changes, then kept current from app_queue's events.
import type { ExtensionState, QueueLive } from '@selfphoneng/shared';
import { field, type AmiMessage } from '../ami/events.ts';

/** QueueMember / QueueMemberStatus Status is a device state (AST_DEVICE_*). */
export function memberState(status: number): ExtensionState {
  switch (status) {
    case 1:
      return 'idle';
    case 2:
      return 'inuse';
    case 3:
      return 'busy';
    case 6:
      return 'ringing';
    case 7:
      return 'ringinuse';
    case 8:
      return 'onhold';
    default:
      return 'unavailable'; // 0 unknown, 4 invalid, 5 unavailable
  }
}

const extOf = (iface: string | undefined) =>
  /^Local\/(\d+)@sp-queue-member/.exec(iface ?? '')?.[1] ?? null;

type Waiting = QueueLive['waiting'][number] & { uniqueid: string };
type Q = {
  id: string;
  name: string;
  waiting: Waiting[];
  members: Map<string, QueueLive['members'][number]>;
};

export class QueueTracker {
  private readonly queues = new Map<string, Q>();
  private readonly emit: (number: string, q: QueueLive | null) => void;

  constructor(emit: (number: string, q: QueueLive | null) => void) {
    this.emit = emit;
  }

  list(): QueueLive[] {
    return [...this.queues.keys()].sort().map((n) => this.view(n)!);
  }

  private view(number: string): QueueLive | null {
    const q = this.queues.get(number);
    if (!q) return null;
    return {
      id: q.id,
      number,
      name: q.name,
      waiting: q.waiting.map(({ uniqueid: _u, ...w }) => w),
      members: [...q.members.values()].sort((a, b) => a.ext.localeCompare(b.ext)),
    };
  }

  /** Queues from the DB, and QueueStatus items (QueueParams, QueueMember, QueueEntry). */
  load(defs: { id: string; number: string; name: string }[], items: AmiMessage[]): void {
    const before = new Set(this.queues.keys());
    this.queues.clear();
    for (const d of defs)
      this.queues.set(d.number, { id: d.id, name: d.name, waiting: [], members: new Map() });
    const now = Date.now();
    for (const m of items) {
      const q = this.queues.get(field(m, 'Queue') ?? '');
      if (!q) continue;
      if (field(m, 'Event') === 'QueueMember') this.member(q, m);
      if (field(m, 'Event') === 'QueueEntry')
        q.waiting.push({
          uniqueid: field(m, 'Uniqueid') ?? '',
          linkedid: field(m, 'Linkedid') ?? field(m, 'Uniqueid') ?? '',
          callerNumber: field(m, 'CallerIDNum') ?? '',
          callerName: field(m, 'CallerIDName') || undefined,
          since: new Date(now - Number(field(m, 'Wait') ?? 0) * 1000).toISOString(),
        });
    }
    for (const n of before) if (!this.queues.has(n)) this.emit(n, null);
    for (const n of this.queues.keys()) this.emit(n, this.view(n));
  }

  private member(q: Q, m: AmiMessage): boolean {
    const ext = extOf(field(m, 'Interface') ?? field(m, 'Location') ?? field(m, 'StateInterface'));
    if (!ext) return false;
    const prev = q.members.get(ext);
    const last = Number(field(m, 'LastCall') ?? 0);
    q.members.set(ext, {
      ext,
      paused:
        field(m, 'Paused') !== undefined ? field(m, 'Paused') === '1' : (prev?.paused ?? false),
      state:
        field(m, 'Status') !== undefined
          ? memberState(Number(field(m, 'Status')))
          : (prev?.state ?? 'unavailable'),
      callsTaken: Number(field(m, 'CallsTaken') ?? prev?.callsTaken ?? 0),
      lastCall: last > 0 ? new Date(last * 1000).toISOString() : prev?.lastCall,
    });
    return true;
  }

  handle(m: AmiMessage): void {
    const number = field(m, 'Queue') ?? '';
    const q = this.queues.get(number);
    if (!q) return;
    const uniqueid = field(m, 'Uniqueid') ?? '';
    switch (field(m, 'Event')) {
      case 'QueueCallerJoin':
        q.waiting = [
          ...q.waiting.filter((w) => w.uniqueid !== uniqueid),
          {
            uniqueid,
            linkedid: field(m, 'Linkedid') ?? uniqueid,
            callerNumber: field(m, 'CallerIDNum') ?? '',
            callerName: field(m, 'CallerIDName') || undefined,
            since: new Date().toISOString(),
          },
        ];
        break;
      case 'QueueCallerLeave':
      case 'QueueCallerAbandon':
        if (!q.waiting.some((w) => w.uniqueid === uniqueid)) return;
        q.waiting = q.waiting.filter((w) => w.uniqueid !== uniqueid);
        break;
      case 'QueueMemberStatus':
      case 'QueueMemberPause':
      case 'QueueMemberAdded':
        if (!this.member(q, m)) return;
        break;
      case 'QueueMemberRemoved': {
        const ext = extOf(field(m, 'Interface'));
        if (!ext || !q.members.delete(ext)) return;
        break;
      }
      default:
        return;
    }
    this.emit(number, this.view(number));
  }
}
