// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isHoliday, rangesToSlots, slotsToRanges, timeConditionStatus } from './timeconditions.ts';

const tc = {
  timezone: 'America/Chicago',
  openRanges: [
    { days: ['mon', 'tue', 'wed', 'thu', 'fri'] as const, start: '08:00', end: '17:00' },
  ].map((r) => ({ ...r, days: [...r.days] })),
  useHolidays: true,
  overrideState: null,
};
// 2026-10-19 is a Monday; Chicago is UTC-5 (CDT) then.
const at = (localHHMM: string, date = '2026-10-19') => new Date(`${date}T${localHHMM}:00-05:00`);

describe('timeConditionStatus', () => {
  it('open inside the hours, closed at the end minute and on weekends', () => {
    expect(timeConditionStatus(tc, [], at('08:00')).now).toBe('open');
    expect(timeConditionStatus(tc, [], at('16:59')).now).toBe('open');
    expect(timeConditionStatus(tc, [], at('17:00')).now).toBe('closed');
    expect(timeConditionStatus(tc, [], at('07:59')).now).toBe('closed');
    expect(timeConditionStatus(tc, [], at('12:00', '2026-10-18')).now).toBe('closed'); // Sunday
  });

  it('uses the condition time zone, not the server one', () => {
    const ny = { ...tc, timezone: 'America/New_York' }; // 08:30 Chicago = 09:30 New York
    expect(timeConditionStatus(ny, [], at('07:30')).now).toBe('open');
    expect(timeConditionStatus(tc, [], at('07:30')).now).toBe('closed');
  });

  it('holidays beat hours; overrides beat everything', () => {
    const h = [{ startDate: '2026-10-19', endDate: '2026-10-19', recurringYearly: false }];
    expect(timeConditionStatus(tc, h, at('10:00'))).toEqual({ now: 'holiday', reason: 'holiday' });
    expect(timeConditionStatus({ ...tc, useHolidays: false }, h, at('10:00')).now).toBe('open');
    expect(timeConditionStatus({ ...tc, overrideState: 'closed' }, [], at('10:00'))).toEqual({
      now: 'closed',
      reason: 'override',
    });
  });
});

describe('isHoliday', () => {
  it('one-off ranges and yearly ones, including over New Year', () => {
    const range = { startDate: '2026-12-24', endDate: '2026-12-26', recurringYearly: false };
    expect(isHoliday(range, '2026-12-25')).toBe(true);
    expect(isHoliday(range, '2027-12-25')).toBe(false);
    const xmas = { startDate: '2020-12-25', endDate: '2020-12-25', recurringYearly: true };
    expect(isHoliday(xmas, '2031-12-25')).toBe(true);
    const nye = { startDate: '2020-12-31', endDate: '2021-01-01', recurringYearly: true };
    expect(isHoliday(nye, '2030-01-01')).toBe(true);
    expect(isHoliday(nye, '2030-01-02')).toBe(false);
  });
});

describe('weekly grid', () => {
  it('round-trips ranges, grouping days with the same hours', () => {
    const ranges = [
      {
        days: ['mon' as const, 'tue' as const, 'wed' as const, 'thu' as const, 'fri' as const],
        start: '08:00',
        end: '12:00',
      },
      {
        days: ['mon' as const, 'tue' as const, 'wed' as const, 'thu' as const, 'fri' as const],
        start: '13:00',
        end: '17:30',
      },
      { days: ['sat' as const], start: '09:00', end: '24:00' },
    ];
    const slots = rangesToSlots(ranges);
    expect(slots.mon[16]).toBe(true); // 08:00
    expect(slots.mon[24]).toBe(false); // 12:00 (lunch)
    expect(slots.sat[47]).toBe(true); // 23:30
    expect(slotsToRanges(slots)).toEqual(ranges);
  });

  it('a day painted differently splits from the group', () => {
    const slots = rangesToSlots([{ days: ['mon', 'tue'], start: '08:00', end: '17:00' }]);
    slots.tue[34] = true; // 17:00-17:30 added on Tuesday only
    expect(slotsToRanges(slots)).toEqual([
      { days: ['mon'], start: '08:00', end: '17:00' },
      { days: ['tue'], start: '08:00', end: '17:30' },
    ]);
  });
});
