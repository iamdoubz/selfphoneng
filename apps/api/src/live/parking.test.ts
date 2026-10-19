// SPDX-License-Identifier: AGPL-3.0-or-later
// Events trimmed from a real Asterisk 24 park and pickup (cdr-record.ts, park-pickup).
import { describe, expect, it } from 'vitest';
import type { ParkedLive } from '@selfphoneng/shared';
import { ParkingTracker } from './parking.ts';

const PARKEE = {
  ParkeeChannel: 'PJSIP/trunk-7d3e9a52-1c4b-4f6e-9a0d-2b8c5e1f4a37-00000016',
  ParkeeCallerIDNum: '13125559999',
  ParkeeCallerIDName: 'Mobile',
  ParkeeUniqueid: '1792400815.54',
  ParkeeLinkedid: '1792400815.54',
  ParkerDialString: 'PJSIP/101',
  Parkinglot: 'default',
  ParkingSpace: '701',
};

describe('ParkingTracker', () => {
  it('follows a call from parked to picked up', () => {
    const sent: [string, ParkedLive | null][] = [];
    const t = new ParkingTracker((slot, p) => sent.push([slot, p]));
    t.handle({ Event: 'ParkedCall', ...PARKEE, ParkingTimeout: '120', ParkingDuration: '0' });
    expect(t.list()).toEqual([
      {
        slot: '701',
        linkedid: '1792400815.54',
        callerNumber: '13125559999',
        callerName: 'Mobile',
        since: expect.any(String),
        parkedBy: '101',
      },
    ]);
    t.handle({ Event: 'UnParkedCall', ...PARKEE, RetrieverChannel: 'PJSIP/103-00000018' });
    expect(t.list()).toEqual([]);
    expect(sent.map(([s, p]) => [s, p === null])).toEqual([
      ['701', false],
      ['701', true],
    ]);
    t.handle({ Event: 'ParkedCallGiveUp', ParkingSpace: '701' }); // already gone: nothing
    expect(sent).toHaveLength(2);
  });

  it('loads ParkedCalls, with how long each has waited', () => {
    const sent: (ParkedLive | null)[] = [];
    const t = new ParkingTracker((_s, p) => sent.push(p));
    t.handle({ Event: 'ParkedCall', ...PARKEE, ParkingSpace: '705' });
    t.load([
      { Event: 'ParkedCall', ...PARKEE, ParkingDuration: '30' },
      { Event: 'ParkedCallsComplete', Total: '1' },
    ]);
    expect(t.list().map((p) => p.slot)).toEqual(['701']);
    expect(Date.now() - Date.parse(t.list()[0]!.since)).toBeGreaterThanOrEqual(29_000);
    expect(sent.at(-2)).toBeNull(); // 705 went away while we weren't looking
  });
});
