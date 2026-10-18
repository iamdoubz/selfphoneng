// SPDX-License-Identifier: AGPL-3.0-or-later
// Recordings (05 §2): every recorded call, newest first; play, download, delete. Calls are
// recorded by user record modes and per phone number; retention is in Settings → Recording.
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { recordingsApi } from '../../api/client.ts';
import { ConfirmDialog } from '../../components/Dialog.tsx';
import { Alert, Button } from '../../components/ui.tsx';
import { fmtDuration, fmtNumber } from './CallsPage.tsx';

export function RecordingsPage() {
  const qc = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: ['recordings'],
    queryFn: ({ pageParam }) => recordingsApi.list(pageParam),
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
      <p className="text-sm text-zinc-500">
        Calls are recorded when a user's record mode or a phone number says so. How long they're
        kept is under Settings → Recording.
      </p>
      {list.isError && <Alert>{list.error.message}</Alert>}
      {list.data && items.length === 0 && <p className="text-sm text-zinc-500">No recordings.</p>}
      <ul
        aria-label="Recordings"
        className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800"
      >
        {items.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm">
            <span className="w-36 text-zinc-500">{new Date(r.startedAt).toLocaleString()}</span>
            <span className="min-w-0 flex-1">
              {r.call
                ? `${r.call.fromName ?? fmtNumber(r.call.fromNumber)} → ${fmtNumber(r.call.toNumber)}`
                : 'Call not found'}
              {r.durationMs !== null && (
                <span className="text-zinc-500">
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
              className="rounded-md px-3 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Download
            </a>
            <Button variant="ghost" onClick={() => setDeleting(r.id)}>
              Delete
            </Button>
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
        message={<p>Delete this recording? This can't be undone.</p>}
        confirmLabel="Delete"
        busy={remove.isPending}
        error={remove.error?.message}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </section>
  );
}
