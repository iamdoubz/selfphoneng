// SPDX-License-Identifier: AGPL-3.0-or-later
// Events below are trimmed from a real Asterisk 24 call into queue 550 (cdr-record.ts).
import { describe, expect, it } from 'vitest';
import type { QueueLive } from '@selfphoneng/shared';
import { QueueTracker } from './queues.ts';

const DEFS = [{ id: 'q-550', number: '550', name: 'Support' }];
const IFACE = 'Local/101@sp-queue-member/n';
const CALLER = { Queue: '550', Uniqueid: '1792369984.35', Linkedid: '1792369984.35' };

function tracker() {
  const sent: (QueueLive | null)[] = [];
  const t = new QueueTracker((_n, q) => sent.push(q));
  return { t, sent };
}

describe('QueueTracker', () => {
  it('loads QueueStatus and follows a caller from joining to an agent', () => {
    const { t, sent } = tracker();
    t.load(DEFS, [
      { Event: 'QueueParams', Queue: '550' },
      {
        Event: 'QueueMember',
        Queue: '550',
        Name: 'Alice',
        Location: IFACE,
        StateInterface: 'hint:101@sp-local-numbers',
        Status: '1',
        Paused: '0',
        CallsTaken: '0',
        LastCall: '0',
      },
      {
        Event: 'QueueEntry',
        Queue: '550',
        Uniqueid: '9.1',
        CallerIDNum: '13125550001',
        Wait: '30',
      },
      { Event: 'QueueStatusComplete' },
    ]);
    expect(t.list()[0]).toMatchObject({
      id: 'q-550',
      name: 'Support',
      members: [{ ext: '101', paused: false, state: 'idle', callsTaken: 0 }],
      waiting: [{ callerNumber: '13125550001', linkedid: '9.1' }],
    });
    const since = Date.parse(t.list()[0]!.waiting[0]!.since);
    expect(Date.now() - since).toBeGreaterThanOrEqual(29_000);

    t.handle({
      Event: 'QueueCallerJoin',
      ...CALLER,
      CallerIDNum: '13125559999',
      CallerIDName: 'Mobile',
    });
    expect(t.list()[0]!.waiting.map((w) => w.callerNumber)).toEqual(['13125550001', '13125559999']);
    t.handle({
      Event: 'QueueMemberStatus',
      Queue: '550',
      MemberName: 'Alice',
      Interface: IFACE,
      Status: '6',
      Paused: '0',
      CallsTaken: '0',
      LastCall: '0',
    });
    expect(t.list()[0]!.members[0]!.state).toBe('ringing');
    t.handle({ Event: 'QueueCallerLeave', ...CALLER, Position: '1', Count: '0' });
    t.handle({ Event: 'AgentConnect', ...CALLER, HoldTime: '0', Interface: IFACE });
    t.handle({
      Event: 'QueueMemberStatus',
      Queue: '550',
      MemberName: 'Alice',
      Interface: IFACE,
      Status: '1',
      Paused: '0',
      CallsTaken: '1',
      LastCall: '1792369988',
      InCall: '0',
    });
    expect(t.list()[0]).toMatchObject({
      waiting: [{ callerNumber: '13125550001' }],
      members: [
        {
          ext: '101',
          state: 'idle',
          callsTaken: 1,
          lastCall: new Date(1792369988000).toISOString(),
        },
      ],
    });
    expect(sent.length).toBe(5); // load, join, ringing, leave, idle: AgentConnect changes nothing
  });

  it('pause, unknown queues, and queues that went away', () => {
    const { t, sent } = tracker();
    t.load(DEFS, [
      { Event: 'QueueMember', Queue: '550', Location: IFACE, Status: '1', Paused: '0' },
    ]);
    t.handle({
      Event: 'QueueMemberPause',
      Queue: '550',
      Interface: IFACE,
      Paused: '1',
      PausedReason: '',
    });
    expect(t.list()[0]!.members[0]).toMatchObject({ paused: true, state: 'idle' });
    sent.length = 0;
    t.handle({ Event: 'QueueCallerJoin', Queue: '999', Uniqueid: '1.1' });
    t.handle({ Event: 'QueueCallerAbandon', Queue: '550', Uniqueid: 'nobody' });
    expect(sent).toEqual([]);
    t.load([], []);
    expect(sent).toEqual([null]);
    expect(t.list()).toEqual([]);
  });
});
