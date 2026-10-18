// SPDX-License-Identifier: AGPL-3.0-or-later
// M7-T4: CallTracker on the recorded M2 session (102 calls 101, they talk, hang up) and on a
// CoreShowChannels load.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ActiveCall } from '@selfphoneng/shared';
import { AmiParser, field } from '../ami/events.ts';
import { CallTracker, extOfChannel } from './calls.ts';

const MSGS = new AmiParser().push(
  readFileSync(new URL('../../test/fixtures/ami/register-and-call.raw', import.meta.url), 'latin1'),
);

describe('CallTracker', () => {
  it('follows a whole call: ringing, talking, gone', () => {
    const seen: (ActiveCall | null)[] = [];
    const t = new CallTracker((_l, c) => seen.push(c));
    let talking: ActiveCall | undefined;
    for (const m of MSGS) {
      t.handle(m);
      if (field(m, 'Event') === 'BridgeEnter') talking = t.list()[0];
    }
    const ringing = seen.find((c) => c?.channels.length === 2 && c.state === 'ringing');
    expect(ringing).toBeDefined();
    expect(talking).toMatchObject({
      direction: 'internal',
      state: 'talking',
      from: { number: '102', name: 'Bob' },
      to: { number: '101' },
      extensions: ['102', '101'],
      channels: ['PJSIP/102-00000000', 'PJSIP/101-00000001'],
      recording: false,
    });
    expect(talking!.answeredAt).toBeDefined();
    expect(t.list()).toEqual([]);
    expect(seen.at(-1)).toBeNull();
  });

  it('loads calls already up from CoreShowChannels', () => {
    const t = new CallTracker(() => undefined);
    const ch = (Channel: string, extra: Record<string, string>) => ({
      Event: 'CoreShowChannel',
      Channel,
      Linkedid: '1.0',
      ChannelStateDesc: 'Up',
      Duration: '00:01:05',
      BridgeId: 'b1',
      ...extra,
    });
    t.load([
      ch('PJSIP/trunk-7d3e9a52-1c4b-4f6e-9a0d-2b8c5e1f4a37-0000000a', {
        CallerIDNum: '13125559999',
        CallerIDName: 'Mobile',
        Application: 'Dial',
        Uniqueid: '1.0',
      }),
      ch('PJSIP/101-0000000b', { CallerIDNum: '101', Application: 'AppDial', Uniqueid: '1.1' }),
      { Event: 'CoreShowChannelsComplete' },
    ]);
    const [c] = t.list();
    expect(c).toMatchObject({
      direction: 'inbound',
      state: 'talking',
      from: { number: '13125559999', name: 'Mobile' },
      to: { number: '101' },
    });
    expect(Date.now() - Date.parse(c!.startedAt)).toBeGreaterThan(64_000);
    expect(t.channelsOf('1.0')).toHaveLength(2);
  });

  it('maps channel names to extensions', () => {
    expect(extOfChannel('PJSIP/101-0000001a')).toBe('101');
    expect(extOfChannel('PJSIP/101-web-0000001a')).toBe('101');
    expect(extOfChannel('Local/102@sp-rg-member-00000003;2')).toBe('102');
    expect(extOfChannel('PJSIP/trunk-7d3e9a52-1c4b-4f6e-9a0d-2b8c5e1f4a37-0000000a')).toBeNull();
  });
});
