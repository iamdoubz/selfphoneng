// SPDX-License-Identifier: AGPL-3.0-or-later
// Office hours (03 §6.10): an override from AstDB wins, then holidays, then the weekly ranges.
// Also sp-tc-override, which the admin feature codes *31N/*32N/*33N jump into (03 §6.13).
import type { Snapshot, SnapHoliday } from '../load.ts';
import * as s from '../sanitize.ts';
import { destApp } from './inbound.ts';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 86_400_000;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** GotoIfTime's end minute is inclusive, ours is exclusive: closing at 17:00 renders 16:59. */
function minuteBefore(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const t = h * 60 + m - 1;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * Every (day, month) a holiday covers. GotoIfTime can't match a year, so a one-off holiday is
 * only rendered while it's within the coming year (the nightly regenerate drops past ones).
 */
function holidayDays(hs: SnapHoliday[], today: string): string[] {
  const from = day(today);
  const until = from + 364 * DAY_MS;
  const out = new Set<string>();
  for (const h of hs)
    for (let t = day(h.startDate); t <= day(h.endDate); t += DAY_MS) {
      if (!h.recurringYearly && (t < from || t > until)) continue;
      const iso = isoOf(t);
      out.add(`${Number(iso.slice(5, 7))}|${Number(iso.slice(8, 10))}`);
    }
  return [...out]
    .map((k) => k.split('|').map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([m, d]) => `${d},${MONTHS[m - 1]}`);
}

export function renderTimeConditions(snap: Snapshot): string {
  const tcs = [...snap.timeConditions].sort((a, b) => a.id.localeCompare(b.id));
  const contexts = tcs.map((t) => {
    const id = s.ident(t.id);
    const tz = s.timezone(t.timezone);
    return [
      `; ─── Office hours "${s.name(t.name)}"`,
      `[sp-tc-${id}]`,
      `exten => s,1,Set(OVR=\${DB(SP/TCOVR/${id})})`,
      ' same => n,GotoIf($["${OVR}" = "open"]?open)',
      ' same => n,GotoIf($["${OVR}" = "closed"]?closed)',
      ...(t.useHolidays
        ? holidayDays(snap.holidays, snap.today).map(
            (dm) => ` same => n,GotoIfTime(*,*,${dm},${tz}?holiday)`,
          )
        : []),
      ...t.openRanges.map(
        (r) =>
          ` same => n,GotoIfTime(${s.hhmm(r.start)}-${minuteBefore(s.hhmm(r.end))},${r.days.map(s.weekday).join('&')},*,*,${tz}?open)`,
      ),
      ' same => n,Goto(closed)',
      ` same => n(open),${destApp(t.openDestination, snap)}`,
      ` same => n(closed),${destApp(t.closedDestination, snap)}`,
      ` same => n(holiday),${destApp(t.holidayDestination ?? t.closedDestination, snap)}`,
      '',
    ].join('\n');
  });

  // *31N force open, *32N force closed, *33N automatic. Unknown N: "no service".
  const override = [
    '; ─── Office hours overrides (admins only, see sp-featurecodes)',
    '[sp-tc-override]',
  ];
  for (const t of tcs.filter((x) => x.overrideDigit !== null)) {
    const id = s.ident(t.id);
    const n = s.digits(String(t.overrideDigit));
    for (const [code, value, set, sound] of [
      [`*31${n}`, 'open', `Set(DB(SP/TCOVR/${id})=open)`, 'activated'],
      [`*32${n}`, 'closed', `Set(DB(SP/TCOVR/${id})=closed)`, 'activated'],
      [`*33${n}`, 'auto', `Set(X=\${DB_DELETE(SP/TCOVR/${id})})`, 'de-activated'],
    ])
      override.push(
        `exten => ${code},1,${set}`,
        ` same => n,UserEvent(SpToggle,Key: TCOVR,Id: ${id},Value: ${value})`,
        ` same => n,Playback(${sound})`,
        ' same => n,Hangup()',
      );
  }
  override.push('exten => _*3[123]X,1,Playback(ss-noservice)', ' same => n,Hangup()', '');
  return [...contexts, override.join('\n')].join('\n');
}
