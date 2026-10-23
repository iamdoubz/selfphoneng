// SPDX-License-Identifier: AGPL-3.0-or-later
// C5: what a call looks like on a Contrack timeline (11 §4.4).
import { describe, expect, it } from 'vitest';
import { splitSummary, timelineEntry, type TimelineCall } from './timeline.ts';

const call = (c: Partial<TimelineCall>): TimelineCall => ({
  out: false,
  status: 'answered',
  fromNumber: '13125551234',
  toNumber: '13125550000',
  talkSeconds: 192,
  answeredBy: null,
  recorded: false,
  ...c,
});

describe('timelineEntry', () => {
  it('titles calls from where the person sat', () => {
    const t = (c: Partial<TimelineCall>) => timelineEntry(call(c), null).title;
    expect(t({})).toBe('Incoming call');
    expect(t({ answeredBy: 'Sue Smith' })).toBe('Incoming call, answered by Sue Smith');
    expect(t({ status: 'missed', talkSeconds: 0 })).toBe('Missed call');
    expect(t({ status: 'voicemail', talkSeconds: 0 })).toBe('Missed call, voicemail left');
    expect(t({ out: true })).toBe('Outgoing call');
    expect(t({ out: true, status: 'busy', talkSeconds: 0 })).toBe('Outgoing call, busy');
    expect(t({ out: true, status: 'failed', talkSeconds: 0 })).toBe('Outgoing call, no answer');
  });

  it('writes the facts, the summary and its action items as escaped HTML', () => {
    const e = timelineEntry(
      call({ recorded: true }),
      'Acme <wants> a quote & a call back.\nAction items:\n- Dan sends the quote\n- Sue books a visit',
    );
    expect(e).toEqual({
      title: 'Incoming call',
      content:
        '<p>From (312) 555-1234 to (312) 555-0000 · 3:12 · recorded</p>' +
        '<p>Acme &lt;wants&gt; a quote &amp; a call back.</p>' +
        '<p>Action items:</p><ul><li>Dan sends the quote</li><li>Sue books a visit</li></ul>',
      duration: 4,
      firstItem: 'Dan sends the quote',
    });
    const missed = timelineEntry(call({ status: 'missed', talkSeconds: 0 }), null);
    expect([missed.content, missed.duration, missed.firstItem]).toEqual([
      '<p>From (312) 555-1234 to (312) 555-0000</p>',
      null,
      null,
    ]);
    expect(timelineEntry(call({ out: true }), null).content).toBe(
      '<p>To (312) 555-0000 · 3:12</p>',
    );
  });

  it('reads "Action items: none" as none', () => {
    expect(splitSummary('Wrong number.\nAction items: none')).toEqual({
      text: ['Wrong number.'],
      items: [],
    });
    expect(splitSummary('Just chatted.')).toEqual({ text: ['Just chatted.'], items: [] });
    expect(splitSummary('X.\nAction items:\n- none')).toEqual({ text: ['X.'], items: [] });
  });
});
