// SPDX-License-Identifier: AGPL-3.0-or-later
// Reports (05 §2): totals (calls, minutes, the voip.ms balance), calls and outside minutes per
// day, missed per day, busiest hours, queue table.
// ponytail: bars and the heatmap are plain divs and a table, no chart library.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReportRange, ReportSummary } from '@selfphoneng/shared';
import { reportsApi } from '../../api/client.ts';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';
import { fmtDuration } from './CallsPage.tsx';

const SERIES = [
  ['inbound', 'In', 'bg-sky-500'],
  ['outbound', 'Out', 'bg-violet-500'],
  ['internal', 'Internal', 'bg-zinc-400'],
] as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** 75 → "1 min", 4000 → "1 h 7 min": totals, rounded to the minute. */
const fmtMinutes = (s: number) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const shortDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

function Bars({
  label,
  days,
  segments,
}: {
  label: string;
  days: ReportSummary['days'];
  segments: readonly (readonly [keyof ReportSummary['days'][number], string, string])[];
}) {
  const total = (d: ReportSummary['days'][number]) =>
    segments.reduce((s, [k]) => s + Number(d[k]), 0);
  const max = Math.max(1, ...days.map(total));
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="flex flex-wrap items-center gap-3 font-medium">
        {label}
        {segments.length > 1 &&
          segments.map(([k, text, color]) => (
            <span key={k} className="flex items-center gap-1 text-xs font-normal text-zinc-500">
              <span className={`inline-block size-2.5 rounded-sm ${color}`} />
              {text}
            </span>
          ))}
        <span className="text-xs font-normal text-zinc-500">most in a day: {max}</span>
      </figcaption>
      <div className="flex h-40 items-end gap-px border-b border-zinc-300 dark:border-zinc-700">
        {days.map((d) => (
          <div
            key={d.date}
            role="img"
            aria-label={`${shortDate(d.date)}: ${segments.map(([k, text]) => `${d[k]} ${text.toLowerCase()}`).join(', ')}`}
            title={`${shortDate(d.date)}: ${segments.map(([k, text]) => `${d[k]} ${text.toLowerCase()}`).join(', ')}`}
            className="flex h-full min-w-0 flex-1 flex-col-reverse hover:opacity-80"
          >
            {segments.map(([k, , color]) => (
              <div key={k} className={color} style={{ height: `${(100 * Number(d[k])) / max}%` }} />
            ))}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-zinc-500">
        <span>{shortDate(days[0]!.date)}</span>
        <span>{shortDate(days.at(-1)!.date)}</span>
      </div>
    </figure>
  );
}

function Heatmap({ hours }: { hours: number[][] }) {
  const max = Math.max(1, ...hours.flat());
  return (
    <div className="overflow-x-auto">
      <table aria-label="Busiest hours" className="border-separate border-spacing-0.5 text-xs">
        <thead>
          <tr>
            <th />
            {hours[0]!.map((_, h) => (
              <th key={h} scope="col" className="w-6 font-normal text-zinc-500">
                {h % 3 === 0 ? h : <span className="sr-only">{h}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hours.map((row, d) => (
            <tr key={d}>
              <th scope="row" className="pr-1 text-left font-normal text-zinc-500">
                {WEEKDAYS[d]}
              </th>
              {row.map((n, h) => (
                <td
                  key={h}
                  title={`${WEEKDAYS[d]} ${h}:00: ${n} calls`}
                  className="h-6 w-6 rounded-sm bg-zinc-100 dark:bg-zinc-800"
                  style={
                    n ? { backgroundColor: `rgb(14 165 233 / ${0.15 + (0.85 * n) / max})` } : {}
                  }
                >
                  <span className="sr-only">{n}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReportsPage() {
  const [draft, setDraft] = useState<ReportRange>({});
  const [range, setRange] = useState<ReportRange>({});
  const summary = useQuery({
    queryKey: ['reports', 'summary', range],
    queryFn: () => reportsApi.summary(range),
  });
  const queues = useQuery({
    queryKey: ['reports', 'queues', range],
    queryFn: () => reportsApi.queues(range),
  });
  const balance = useQuery({ queryKey: ['reports', 'balance'], queryFn: reportsApi.balance });
  const s = summary.data;
  const date = (k: 'from' | 'to', label: string) => (
    <Field label={label}>
      {(p) => (
        <input
          {...p}
          type="date"
          className={inputClass}
          value={draft[k] ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value || undefined }))}
        />
      )}
    </Field>
  );

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Reports</h1>
      <form
        aria-label="Dates"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setRange(draft);
        }}
      >
        <div className="w-40">{date('from', 'From')}</div>
        <div className="w-40">{date('to', 'To')}</div>
        <Button type="submit" variant="primary">
          Show
        </Button>
        {s && (
          <p className="text-sm text-zinc-500">
            {shortDate(s.from)} – {shortDate(s.to)}
            {!range.from && !range.to && ' (last 30 days)'}
          </p>
        )}
      </form>
      {summary.error && <Alert>{summary.error.message}</Alert>}

      {s && (
        <>
          <dl aria-label="Totals" className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {(
              [
                ['Calls', s.totals.calls, null],
                ['Answered', s.totals.answered, null],
                ['Missed', s.totals.missed, 'missed, voicemail or hung up waiting'],
                [
                  'Average talk time',
                  s.totals.avgTalkSeconds === null ? '—' : fmtDuration(s.totals.avgTalkSeconds),
                  null,
                ],
                ['Talk time', fmtMinutes(s.totals.talkSeconds), 'people talking, inside calls too'],
                [
                  'Outside minutes',
                  fmtMinutes(s.totals.outsideSeconds.inbound + s.totals.outsideSeconds.outbound),
                  `${fmtMinutes(s.totals.outsideSeconds.inbound)} in, ${fmtMinutes(s.totals.outsideSeconds.outbound)} out: roughly what voip.ms bills`,
                ],
                ...(balance.data ?? []).map(
                  (b) =>
                    [
                      balance.data!.length > 1 ? `Balance (${b.trunkName})` : 'voip.ms balance',
                      b.balance === null ? '—' : b.balance.toFixed(2),
                      b.error ?? "now, in your voip.ms account's currency",
                    ] as const,
                ),
              ] as const
            ).map(([k, v, note]) => (
              <div key={k} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <dt className="text-zinc-500">{k}</dt>
                <dd className="text-lg font-semibold tabular-nums">{v}</dd>
                {note && <dd className="text-xs text-zinc-500">{note}</dd>}
              </div>
            ))}
          </dl>
          <Bars label="Calls per day" days={s.days} segments={SERIES} />
          <Bars
            label="Outside minutes per day"
            days={s.days}
            segments={[['outsideMinutes', 'Minutes', 'bg-emerald-500']]}
          />
          <Bars
            label="Missed per day"
            days={s.days}
            segments={[['missed', 'Missed', 'bg-red-500']]}
          />
          <div className="flex flex-col gap-1">
            <h2 className="font-medium">Busiest hours</h2>
            <Heatmap hours={s.hours} />
          </div>
        </>
      )}

      <div className="flex flex-col gap-2">
        <h2 className="font-medium">Queues</h2>
        {queues.error && <Alert>{queues.error.message}</Alert>}
        {queues.data && !queues.data.length && <p className="text-sm text-zinc-500">No queues.</p>}
        {!!queues.data?.length && (
          <div className="overflow-x-auto">
            <table aria-label="Queue report" className="w-full text-left text-sm">
              <thead className="text-zinc-500">
                <tr>
                  {[
                    'Queue',
                    'Calls',
                    'Answered',
                    'Hung up waiting',
                    'Timed out',
                    'Average wait',
                    'Answered in time',
                  ].map((h) => (
                    <th key={h} scope="col" className="px-2 py-1 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {queues.data.map((q) => (
                  <tr key={q.id} className="tabular-nums">
                    <td className="px-2 py-1">
                      <span className="font-mono">{q.number}</span> {q.name}
                    </td>
                    <td className="px-2 py-1">{q.offered}</td>
                    <td className="px-2 py-1">{q.answered}</td>
                    <td className="px-2 py-1">{q.abandoned}</td>
                    <td className="px-2 py-1">{q.timedOut}</td>
                    <td className="px-2 py-1">
                      {q.avgWaitSeconds === null ? '—' : `${q.avgWaitSeconds} s`}
                    </td>
                    <td className="px-2 py-1" title={`within ${q.slaSeconds} s`}>
                      {q.withinSlaPercent === null ? '—' : `${q.withinSlaPercent}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
