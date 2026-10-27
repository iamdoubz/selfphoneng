// SPDX-License-Identifier: AGPL-3.0-or-later
// Call history (05 §2): filters, newest first with "Load more", CSV export; a row expands to the
// raw CDR legs. Recordings play here once M7-T3 lands.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CALL_DIRECTIONS,
  CALL_STATUSES,
  formatNumber,
  type CallDto,
  type CallFilter,
} from '@selfphoneng/shared';
import { callsApi, extensionsApi, recordingsApi } from '../../api/client.ts';
import { SpamNote } from '../../components/SpamNote.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

export const fmtNumber = (n: string | null) =>
  !n ? 'Unknown' : n.length > 6 ? formatNumber(n) : n;
export const fmtDuration = (s: number) =>
  `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
export const STATUS_LOOK: Record<CallDto['status'], string> = {
  answered: 'bg-green-100 text-green-900 dark:bg-green-900 dark:text-green-100',
  missed: 'bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100',
  voicemail: 'bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100',
  abandoned: 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100',
  busy: 'bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200',
  failed: 'bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200',
};
export const DIRECTION_TEXT = { inbound: 'In', outbound: 'Out', internal: 'Internal' };

export function StatusBadge({ status }: { status: CallDto['status'] }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_LOOK[status]}`}>{status}</span>;
}

export function CallsPage() {
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const [draft, setDraft] = useState<CallFilter>({});
  const [filter, setFilter] = useState<CallFilter>({});
  const [open, setOpen] = useState<string | null>(null);
  const list = useInfiniteQuery({
    queryKey: ['calls', filter],
    queryFn: ({ pageParam }) => callsApi.list({ ...filter, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const calls = list.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (k: keyof CallFilter) => (v: string) =>
    setDraft((d) => ({ ...d, [k]: v || undefined }));
  const select = (label: string, k: keyof CallFilter, options: [string, string][]) => (
    <Field label={label}>
      {(p) => (
        <select
          {...p}
          className={inputClass}
          value={String(draft[k] ?? '')}
          onChange={(e) => set(k)(e.target.value)}
        >
          <option value="">Any</option>
          {options.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Call history</h1>
        <a
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          href={callsApi.csvUrl(filter)}
        >
          Export CSV
        </a>
      </div>
      <form
        aria-label="Filters"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter(draft);
        }}
      >
        <Field label="From">
          {(p) => (
            <input
              {...p}
              type="date"
              className={inputClass}
              value={draft.from ?? ''}
              onChange={(e) => set('from')(e.target.value)}
            />
          )}
        </Field>
        <Field label="To">
          {(p) => (
            <input
              {...p}
              type="date"
              className={inputClass}
              value={draft.to ?? ''}
              onChange={(e) => set('to')(e.target.value)}
            />
          )}
        </Field>
        {select(
          'Direction',
          'direction',
          CALL_DIRECTIONS.map((d) => [d, DIRECTION_TEXT[d]]),
        )}
        {select(
          'Status',
          'status',
          CALL_STATUSES.map((s) => [s, s]),
        )}
        {select(
          'User',
          'extensionId',
          (exts.data ?? []).map((x) => [x.id, `${x.number} ${x.name}`]),
        )}
        <Field label="Number">
          {(p) => (
            <input
              {...p}
              className={inputClass}
              inputMode="tel"
              value={draft.q ?? ''}
              onChange={(e) => set('q')(e.target.value)}
            />
          )}
        </Field>
        <div className="col-span-full flex gap-2">
          <Button type="submit" variant="primary">
            Apply
          </Button>
          <Button
            onClick={() => {
              setDraft({});
              setFilter({});
            }}
          >
            Clear
          </Button>
        </div>
      </form>
      {list.isError && <Alert>{list.error.message}</Alert>}
      {list.data && calls.length === 0 && <p className="text-sm text-zinc-500">No calls match.</p>}
      <ul
        aria-label="Calls"
        className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800"
      >
        {calls.map((c) => (
          <li key={c.id} className="flex flex-col gap-2 px-3 py-2 text-sm">
            <button
              type="button"
              aria-expanded={open === c.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-left"
              onClick={() => setOpen(open === c.id ? null : c.id)}
            >
              <span className="w-36 text-zinc-500">{new Date(c.startedAt).toLocaleString()}</span>
              <span className="w-14">{DIRECTION_TEXT[c.direction]}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{c.fromName ?? fmtNumber(c.fromNumber)}</span>
                {c.fromName && (
                  <span className="text-zinc-500"> {fmtNumber(c.fromNumber)}</span>
                )} → {fmtNumber(c.toNumber)}
                {c.answeredBy && (
                  <span className="text-zinc-500"> · answered by {c.answeredBy.name}</span>
                )}
                <SpamNote check={c.spam} />
              </span>
              <StatusBadge status={c.status} />
              <span className="w-12 text-right tabular-nums">{fmtDuration(c.talkSeconds)}</span>
            </button>
            {open === c.id && c.recordingId && (
              <audio
                controls
                preload="none"
                src={recordingsApi.audioUrl(c.recordingId)}
                aria-label="Play the recording"
                className="h-9 w-full sm:w-80"
              />
            )}
            {open === c.id && <Legs id={c.id} />}
          </li>
        ))}
      </ul>
      {list.hasNextPage && (
        <div>
          <Button onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}

function Legs({ id }: { id: string }) {
  const d = useQuery({ queryKey: ['call', id], queryFn: () => callsApi.get(id) });
  if (!d.data) return <p className="text-xs text-zinc-500">Loading…</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">Call legs</caption>
        <thead className="text-left text-zinc-500">
          <tr>
            <th className="pr-3 font-normal">Time</th>
            <th className="pr-3 font-normal">From channel</th>
            <th className="pr-3 font-normal">To channel</th>
            <th className="pr-3 font-normal">App</th>
            <th className="pr-3 font-normal">Result</th>
            <th className="font-normal">Talk</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {d.data.legs.map((l, i) => (
            <tr key={i}>
              <td className="pr-3">{l.startAt ? new Date(l.startAt).toLocaleTimeString() : ''}</td>
              <td className="pr-3">{l.channel}</td>
              <td className="pr-3">{l.dstchannel}</td>
              <td className="pr-3">{l.lastapp}</td>
              <td className="pr-3">{l.disposition}</td>
              <td>{l.billsec}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
