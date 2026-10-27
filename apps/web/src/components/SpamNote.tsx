// SPDX-License-Identifier: AGPL-3.0-or-later
// What the spam check said about a caller (14 §5.1): a badge and a line, for high and medium
// risk only. Shown in the softphone and call history.
import type { SpamCheck } from '@selfphoneng/shared';

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** "Fraud score 92 · spammer · VoIP · Verizon · Austin, TX", or "Reported to the FTC 4 times…". */
export function spamLine(c: SpamCheck): string {
  if (c.provider === 'ftc') {
    const i = c.info;
    const times = i.complaints === 1 ? 'once' : `${i.complaints} times`;
    const robo = i.robocalls ? ` (${i.robocalls} robocall${i.robocalls === 1 ? '' : 's'})` : '';
    const last = i.lastReportedAt ? `, last on ${day(i.lastReportedAt)}` : '';
    return `Reported to the FTC ${times}${robo}${last}${i.subject ? `: ${i.subject}` : ''}`;
  }
  const i = c.info;
  const place = [i.city, i.region].filter(Boolean).join(', ');
  return [
    i.name,
    `Fraud score ${i.fraudScore}`,
    i.spammer && 'spammer',
    i.recentAbuse && 'recent abuse',
    i.lineType,
    i.carrier,
    place,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function SpamNote({ check }: { check: SpamCheck | null | undefined }) {
  if (!check || check.risk === 'low') return null;
  const high = check.risk === 'high';
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-sm">
      <span
        className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
          high
            ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200'
            : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
        }`}
      >
        {high ? 'Likely spam' : 'Possible spam'}
      </span>
      <span className="text-zinc-600 dark:text-zinc-400">{spamLine(check)}</span>
    </span>
  );
}
