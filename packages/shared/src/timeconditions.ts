// SPDX-License-Identifier: AGPL-3.0-or-later
// Office hours / time conditions and holidays (02 time_conditions, holidays; 03 §6.10).
import { z } from 'zod';
import { DestinationSchema, type Destination } from './destination.ts';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];

/** "08:00".."24:00"; the end is exclusive (closed at 17:00 means open until 16:59). */
const Time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Like 08:30');

export const OpenRangeSchema = z
  .object({
    days: z.array(z.enum(DAYS)).min(1, 'Pick at least one day'),
    start: Time,
    end: Time,
  })
  // Ranges can't cross midnight: add two (03 §6.10).
  .refine((r) => r.start < r.end, 'The end must be after the start');
export type OpenRange = z.infer<typeof OpenRangeSchema>;

export const OVERRIDE_STATES = ['open', 'closed', 'auto'] as const;
export type OverrideState = (typeof OVERRIDE_STATES)[number];

const TimeConditionFields = z.object({
  name: z.string().trim().min(1, 'Required').max(40),
  timezone: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_+/-]*$/, 'A time zone like America/Chicago')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone'),
  openRanges: z.array(OpenRangeSchema).max(30),
  useHolidays: z.boolean(),
  /** N in the feature codes *31N (force open), *32N (force closed), *33N (automatic). */
  overrideDigit: z.number().int().min(1).max(9).nullable(),
  openDestination: DestinationSchema,
  closedDestination: DestinationSchema,
  /** null = the closed destination. */
  holidayDestination: DestinationSchema.nullable(),
});

export const TimeConditionCreateSchema = TimeConditionFields.partial().required({
  name: true,
  openDestination: true,
  closedDestination: true,
});
export const TimeConditionUpdateSchema = TimeConditionFields.partial();
export type TimeConditionCreate = z.input<typeof TimeConditionCreateSchema>;
export type TimeConditionUpdate = z.input<typeof TimeConditionUpdateSchema>;
export const OverrideBodySchema = z.object({ state: z.enum(OVERRIDE_STATES) });

export type TimeConditionStatus = {
  /** What callers get right now. */
  now: 'open' | 'closed' | 'holiday';
  /** Why: forced by someone, a holiday, or the weekly hours. */
  reason: 'override' | 'holiday' | 'hours';
};

export type TimeConditionDto = z.output<typeof TimeConditionFields> & {
  id: string;
  openDestination: Destination;
  closedDestination: Destination;
  holidayDestination: Destination | null;
  /** null = automatic. */
  overrideState: 'open' | 'closed' | null;
  status: TimeConditionStatus;
  createdAt: string;
};

const Day = z.iso.date();
export const HolidaySchema = z
  .object({
    name: z.string().trim().min(1, 'Required').max(60),
    startDate: Day,
    endDate: Day,
    /** Same month and day every year (e.g. Christmas). */
    recurringYearly: z.boolean().default(false),
  })
  .refine((h) => h.startDate <= h.endDate, {
    message: 'The end is before the start',
    path: ['endDate'],
  })
  .refine((h) => (Date.parse(h.endDate) - Date.parse(h.startDate)) / 86_400_000 < 31, {
    message: 'At most 31 days',
    path: ['endDate'],
  });
export type HolidayInput = z.input<typeof HolidaySchema>;
export type HolidayDto = z.output<typeof HolidaySchema> & { id: string };

/** Day of week and "HH:MM" of `at` in `timezone`. */
export function localTime(at: Date, timezone: string): { day: Day; time: string; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: parts.weekday!.toLowerCase().slice(0, 3) as Day,
    time: `${parts.hour}:${parts.minute}`,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** True when `date` (YYYY-MM-DD) falls on the holiday (recurring ones ignore the year). */
export function isHoliday(
  h: Pick<HolidayDto, 'startDate' | 'endDate' | 'recurringYearly'>,
  date: string,
) {
  if (!h.recurringYearly) return h.startDate <= date && date <= h.endDate;
  const md = date.slice(5);
  const [s, e] = [h.startDate.slice(5), h.endDate.slice(5)];
  return s <= e ? s <= md && md <= e : md >= s || md <= e; // a range over New Year
}

/** The same decision the dialplan makes (03 §6.10): override, then holidays, then hours. */
export function timeConditionStatus(
  tc: Pick<TimeConditionDto, 'timezone' | 'openRanges' | 'useHolidays' | 'overrideState'>,
  holidays: Pick<HolidayDto, 'startDate' | 'endDate' | 'recurringYearly'>[],
  at = new Date(),
): TimeConditionStatus {
  if (tc.overrideState) return { now: tc.overrideState, reason: 'override' };
  const { day, time, date } = localTime(at, tc.timezone);
  if (tc.useHolidays && holidays.some((h) => isHoliday(h, date)))
    return { now: 'holiday', reason: 'holiday' };
  const open = tc.openRanges.some((r) => r.days.includes(day) && r.start <= time && time < r.end);
  return { now: open ? 'open' : 'closed', reason: 'hours' };
}

/** The weekly grid edits half-hour slots: slots[day][0..47], slot i = i*30 min. */
export const SLOTS = 48;
const toSlot = (t: string) => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return (h * 60 + m) / 30;
};
const ofSlot = (i: number) =>
  `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;

/** Ranges → grid. Times between half hours are rounded to the slot they start in. */
export function rangesToSlots(ranges: OpenRange[]): Record<Day, boolean[]> {
  const out = Object.fromEntries(DAYS.map((d) => [d, Array<boolean>(SLOTS).fill(false)])) as Record<
    Day,
    boolean[]
  >;
  for (const r of ranges)
    for (const d of r.days)
      for (let i = Math.floor(toSlot(r.start)); i < Math.ceil(toSlot(r.end)); i++) out[d][i] = true;
  return out;
}

/** Grid → ranges: one range per run of open slots, days with the same run grouped together. */
export function slotsToRanges(slots: Record<Day, boolean[]>): OpenRange[] {
  const byRun = new Map<string, Day[]>();
  for (const d of DAYS) {
    for (let i = 0; i < SLOTS;) {
      if (!slots[d][i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < SLOTS && slots[d][j]) j++;
      const key = `${ofSlot(i)}-${ofSlot(j)}`;
      byRun.set(key, [...(byRun.get(key) ?? []), d]);
      i = j;
    }
  }
  return [...byRun.entries()]
    .map(([run, days]) => {
      const [start, end] = run.split('-') as [string, string];
      return { days, start, end };
    })
    .sort(
      (a, b) =>
        DAYS.indexOf(a.days[0]!) - DAYS.indexOf(b.days[0]!) || a.start.localeCompare(b.start),
    );
}
