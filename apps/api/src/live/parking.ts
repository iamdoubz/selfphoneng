// SPDX-License-Identifier: AGPL-3.0-or-later
// Parked calls (04 §5.1): loaded from ParkedCalls on connect, then ParkedCall adds a slot and
// UnParkedCall (picked up), ParkedCallTimeOut (rang back) and ParkedCallGiveUp (hung up) free it.
import type { ParkedLive } from '@selfphoneng/shared';
import { field, type AmiMessage } from '../ami/events.ts';

const FREED = new Set(['UnParkedCall', 'ParkedCallTimeOut', 'ParkedCallGiveUp']);

export class ParkingTracker {
  private readonly slots = new Map<string, ParkedLive>();
  private readonly emit: (slot: string, p: ParkedLive | null) => void;

  constructor(emit: (slot: string, p: ParkedLive | null) => void) {
    this.emit = emit;
  }

  list(): ParkedLive[] {
    return [...this.slots.values()].sort((a, b) => a.slot.localeCompare(b.slot));
  }

  /** ParkedCalls items (initial load). */
  load(items: AmiMessage[]): void {
    const before = new Set(this.slots.keys());
    this.slots.clear();
    for (const m of items) if (field(m, 'Event') === 'ParkedCall') this.park(m);
    for (const s of before) if (!this.slots.has(s)) this.emit(s, null);
    for (const p of this.slots.values()) this.emit(p.slot, p);
  }

  private park(m: AmiMessage): ParkedLive | null {
    const slot = field(m, 'ParkingSpace') ?? '';
    if (!slot) return null;
    const parker = /^(?:PJSIP|SIP)\/(\d+)/.exec(field(m, 'ParkerDialString') ?? '')?.[1];
    const p: ParkedLive = {
      slot,
      linkedid: field(m, 'ParkeeLinkedid') ?? field(m, 'ParkeeUniqueid') ?? '',
      callerNumber: field(m, 'ParkeeCallerIDNum') ?? '',
      callerName: field(m, 'ParkeeCallerIDName') || undefined,
      since: new Date(Date.now() - Number(field(m, 'ParkingDuration') ?? 0) * 1000).toISOString(),
      parkedBy: parker,
    };
    this.slots.set(slot, p);
    return p;
  }

  handle(m: AmiMessage): void {
    const ev = field(m, 'Event') ?? '';
    if (ev === 'ParkedCall') {
      const p = this.park(m);
      if (p) this.emit(p.slot, p);
    } else if (FREED.has(ev)) {
      const slot = field(m, 'ParkingSpace') ?? '';
      if (this.slots.delete(slot)) this.emit(slot, null);
    }
  }
}
