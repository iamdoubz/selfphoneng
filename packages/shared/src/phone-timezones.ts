// SPDX-License-Identifier: AGPL-3.0-or-later
// Company time zone → what desk phones want (07 §3.4): Yealink's offset and zone name, and a POSIX
// TZ string (Grandstream). Yealink names and the Grandstream format are (verify per model).
// Anything not listed falls back to UTC, and the Phones page says so.
export type PhoneTimezone = { yealinkOffset: string; yealinkName: string; posix: string };

const US_DST = 'M3.2.0,M11.1.0';
const EASTERN = {
  yealinkOffset: '-5',
  yealinkName: 'United States-Eastern Time',
  posix: `EST5EDT,${US_DST}`,
};
const CENTRAL = {
  yealinkOffset: '-6',
  yealinkName: 'United States-Central Time',
  posix: `CST6CDT,${US_DST}`,
};
const MOUNTAIN = {
  yealinkOffset: '-7',
  yealinkName: 'United States-Mountain Time',
  posix: `MST7MDT,${US_DST}`,
};
const PACIFIC = {
  yealinkOffset: '-8',
  yealinkName: 'United States-Pacific Time',
  posix: `PST8PDT,${US_DST}`,
};
export const UTC_PHONE_TZ: PhoneTimezone = {
  yealinkOffset: '0',
  yealinkName: 'UTC',
  posix: 'UTC0',
};

export const PHONE_TIMEZONES: Record<string, PhoneTimezone> = {
  'America/New_York': EASTERN,
  'America/Detroit': EASTERN,
  'America/Toronto': EASTERN,
  'America/Chicago': CENTRAL,
  'America/Winnipeg': CENTRAL,
  'America/Denver': MOUNTAIN,
  'America/Edmonton': MOUNTAIN,
  'America/Boise': MOUNTAIN,
  'America/Phoenix': {
    yealinkOffset: '-7',
    yealinkName: 'United States-MST no DST',
    posix: 'MST7',
  },
  'America/Los_Angeles': PACIFIC,
  'America/Vancouver': PACIFIC,
  'America/Anchorage': {
    yealinkOffset: '-9',
    yealinkName: 'United States-Alaska Time',
    posix: `AKST9AKDT,${US_DST}`,
  },
  'Pacific/Honolulu': {
    yealinkOffset: '-10',
    yealinkName: 'United States-Hawaii-Aleutian',
    posix: 'HST10',
  },
  'America/Halifax': {
    yealinkOffset: '-4',
    yealinkName: 'Canada(Atlantic Time)',
    posix: `AST4ADT,${US_DST}`,
  },
  'America/St_Johns': {
    yealinkOffset: '-3:30',
    yealinkName: 'Canada-New Foundland(St.Johns)',
    posix: `NST3:30NDT,${US_DST}`,
  },
  'Europe/London': {
    yealinkOffset: '0',
    yealinkName: 'United Kingdom(London)',
    posix: 'GMT0BST,M3.5.0/1,M10.5.0',
  },
  UTC: UTC_PHONE_TZ,
  'Etc/UTC': UTC_PHONE_TZ,
};

/** The phone settings for a zone, and whether it's really that zone (false = UTC fallback). */
export function phoneTimezone(iana: string): PhoneTimezone & { supported: boolean } {
  const tz = PHONE_TIMEZONES[iana];
  return tz ? { ...tz, supported: true } : { ...UTC_PHONE_TZ, supported: false };
}
