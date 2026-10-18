// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { usFederalHolidays } from './holidays.ts';

describe('usFederalHolidays', () => {
  it('2026 (July 4 is a Saturday → observed Friday July 3)', () => {
    expect(usFederalHolidays(2026)).toEqual([
      { name: "New Year's Day", date: '2026-01-01' },
      { name: 'Martin Luther King Jr. Day', date: '2026-01-19' },
      { name: "Washington's Birthday", date: '2026-02-16' },
      { name: 'Memorial Day', date: '2026-05-25' },
      { name: 'Juneteenth', date: '2026-06-19' },
      { name: 'Independence Day (observed)', date: '2026-07-03' },
      { name: 'Labor Day', date: '2026-09-07' },
      { name: 'Columbus Day', date: '2026-10-12' },
      { name: 'Veterans Day', date: '2026-11-11' },
      { name: 'Thanksgiving Day', date: '2026-11-26' },
      { name: 'Christmas Day', date: '2026-12-25' },
    ]);
  });

  it('2027: Sunday and Saturday holidays move; Memorial Day is the last Monday', () => {
    const h = Object.fromEntries(usFederalHolidays(2027).map((x) => [x.name, x.date]));
    expect(h['Juneteenth (observed)']).toBe('2027-06-18');
    expect(h['Independence Day (observed)']).toBe('2027-07-05');
    expect(h['Christmas Day (observed)']).toBe('2027-12-24');
    expect(h['Memorial Day']).toBe('2027-05-31');
    expect(h['Thanksgiving Day']).toBe('2027-11-25');
  });
});
