// SPDX-License-Identifier: AGPL-3.0-or-later
// US federal holidays for one year (04 §7.3 POST /api/holidays/import-us-federal), computed here:
// no network. Dates are the days offices close: a Saturday holiday is observed on Friday, a
// Sunday one on Monday (5 U.S.C. 6103).

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

/** The n-th `weekday` (0 = Sunday) of a month; n = -1 is the last one. */
function nth(y: number, m: number, weekday: number, n: number): Date {
  if (n < 0) {
    const last = utc(y, m + 1, 0);
    return utc(y, m, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
  }
  const first = utc(y, m, 1);
  return utc(y, m, 1 + ((weekday - first.getUTCDay() + 7) % 7) + 7 * (n - 1));
}

function observed(d: Date): { date: Date; moved: boolean } {
  const wd = d.getUTCDay();
  if (wd === 6) return { date: new Date(d.getTime() - 86_400_000), moved: true };
  if (wd === 0) return { date: new Date(d.getTime() + 86_400_000), moved: true };
  return { date: d, moved: false };
}

export function usFederalHolidays(year: number): { name: string; date: string }[] {
  const fixed = (name: string, m: number, d: number) => {
    const o = observed(utc(year, m, d));
    return { name: o.moved ? `${name} (observed)` : name, date: iso(o.date) };
  };
  return [
    fixed("New Year's Day", 1, 1),
    { name: 'Martin Luther King Jr. Day', date: iso(nth(year, 1, 1, 3)) },
    { name: "Washington's Birthday", date: iso(nth(year, 2, 1, 3)) },
    { name: 'Memorial Day', date: iso(nth(year, 5, 1, -1)) },
    fixed('Juneteenth', 6, 19),
    fixed('Independence Day', 7, 4),
    { name: 'Labor Day', date: iso(nth(year, 9, 1, 1)) },
    { name: 'Columbus Day', date: iso(nth(year, 10, 1, 2)) },
    fixed('Veterans Day', 11, 11),
    { name: 'Thanksgiving Day', date: iso(nth(year, 11, 4, 4)) },
    fixed('Christmas Day', 12, 25),
  ];
}
