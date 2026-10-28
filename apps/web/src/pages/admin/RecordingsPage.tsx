// SPDX-License-Identifier: AGPL-3.0-or-later
// Recordings (05 §2): every recorded call, newest first; play, download, delete. Calls are
// recorded by user record modes and per phone number; retention is in Settings → Recording.
// With call transcripts on (spec 10 §3): the summary, the transcript, and search.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { recordingsApi } from '../../api/client.ts';
import { ConfirmDialog } from '../../components/Dialog.tsx';
import { Alert, Button, inputClass } from '../../components/ui.tsx';
import { fmtDuration, fmtNumber } from './CallsPage.tsx';

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Who said what, fetched when opened. */
function Transcript({ id }: { id: string }) {
  const t = useQuery({ queryKey: ['transcript', id], queryFn: () => recordingsApi.transcript(id) });
  if (t.error) return <Alert>{t.error.message}</Alert>;
  if (!t.data) return <p className="text-muted">Loading…</p>;
  return (
    <ol aria-label="Transcript" className="mt-1 flex flex-col gap-1">
      {t.data.lines.map((l, i) => (
        <li key={i} className="flex gap-2">
          <span className="w-10 shrink-0 text-muted tabular-nums">{mmss(l.at)}</span>
          <span className="w-20 shrink-0 font-medium">
            {l.side === 'caller' ? 'Caller' : 'Other side'}
          </span>
          <span>{l.text}</span>
        </li>
      ))}
      {!t.data.lines.length && <li className="text-muted">No words.</li>}
    </ol>
  );
}

export function RecordingsPage() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const list = useInfiniteQuery({
    queryKey: ['recordings', q],
    queryFn: ({ pageParam }) => recordingsApi.list(pageParam, q || undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => recordingsApi.remove(id),
    onSuccess: async () => {
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: ['recordings'] });
    },
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Recordings</h1>
      <p className="text-sm text-muted">
        Calls are recorded when a user's record mode or a phone number says so. How long they're
        kept is under Settings → Recording. With call transcripts on (Settings → AI), each call is
        written out a minute or two after it ends.
      </p>
      <form
        role="search"
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
        }}
      >
        <input
          aria-label="Search transcripts"
          placeholder="Search what was said"
          className={`${inputClass} max-w-72`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit">Search</Button>
        {q && (
          <Button
            variant="ghost"
            onClick={() => {
              setDraft('');
              setQ('');
            }}
          >
            Clear
          </Button>
        )}
      </form>
      {list.isError && <Alert>{list.error.message}</Alert>}
      {list.data && items.length === 0 && (
        <p className="text-sm text-muted">{q ? 'No call mentions that.' : 'No recordings.'}</p>
      )}
      <ul
        aria-label="Recordings"
        className="divide-y divide-line rounded-xl border border-line bg-surface shadow-sm"
      >
        {items.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm">
            <span className="w-36 text-muted">{new Date(r.startedAt).toLocaleString()}</span>
            <span className="min-w-0 flex-1">
              {r.call
                ? `${r.call.fromName ?? fmtNumber(r.call.fromNumber)} → ${fmtNumber(r.call.toNumber)}`
                : 'Call not found'}
              {r.durationMs !== null && (
                <span className="text-muted">
                  {' '}
                  · {fmtDuration(Math.round(r.durationMs / 1000))}
                </span>
              )}
            </span>
            <audio
              controls
              preload="none"
              src={recordingsApi.audioUrl(r.id)}
              aria-label="Play recording"
              className="h-9 w-full sm:w-64"
            />
            <a
              href={recordingsApi.audioUrl(r.id, true)}
              className="rounded-md px-3 py-2 text-sm font-medium hover:bg-subtle"
            >
              Download
            </a>
            <Button variant="ghost" onClick={() => setDeleting(r.id)}>
              Delete
            </Button>
            {r.summary && (
              <p aria-label="Summary" className="w-full whitespace-pre-line text-fg">
                {r.summary}
              </p>
            )}
            {r.aiError && (
              <p className="w-full text-xs text-muted">
                {r.hasTranscript ? '' : 'No transcript: '}
                {r.aiError}
              </p>
            )}
            {r.hasTranscript && (
              <div className="w-full">
                <Button variant="ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {open === r.id ? 'Hide transcript' : 'Show transcript'}
                </Button>
                {open === r.id && <Transcript id={r.id} />}
              </div>
            )}
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
      <ConfirmDialog
        open={deleting !== null}
        title="Delete recording"
        message={<p>Delete this recording and its transcript? This can't be undone.</p>}
        confirmLabel="Delete"
        busy={remove.isPending}
        error={remove.error?.message}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </section>
  );
}
