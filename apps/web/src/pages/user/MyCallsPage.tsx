// SPDX-License-Identifier: AGPL-3.0-or-later
// My calls (05 §4): my call history; click the other number to call back (the softphone when it's
// on, else my desk phone rings first). Names from my contacts (11 §1), "Add to contacts".
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { MyCallDto } from '@selfphoneng/shared';
import { meApi, recordingsApi } from '../../api/client.ts';
import { Alert, Button } from '../../components/ui.tsx';
import { softphone } from '../../softphone/SoftphoneEngine.ts';
import { DIRECTION_TEXT, StatusBadge, fmtDuration, fmtNumber } from '../admin/CallsPage.tsx';
import { AddToContacts, useContactName } from './ContactsPage.tsx';
import { SpamNote } from '../../components/SpamNote.tsx';

/** The other side of the call, from where I sit. */
export const otherParty = (c: MyCallDto) =>
  c.myRole === 'out'
    ? { number: c.toNumber, name: null }
    : { number: c.fromNumber, name: c.fromName };

export function useCallBack() {
  const [note, setNote] = useState<string | null>(null);
  const call = (number: string) => {
    setNote(null);
    const p =
      softphone.state.reg === 'registered'
        ? softphone.call(number).then(() => null)
        : meApi.clickToCall(number).then(() => 'Your desk phone is ringing. Pick it up to call.');
    p.then(setNote, (e: Error) => setNote(e.message));
  };
  return { call, note };
}

export function MyCallsPage() {
  const list = useInfiniteQuery({
    queryKey: ['me', 'calls'],
    queryFn: ({ pageParam }) => meApi.calls(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const { call, note } = useCallBack();
  const nameOf = useContactName();
  const calls = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section aria-labelledby="calls-h" className="flex flex-col gap-3">
      <h2 id="calls-h" className="text-lg font-semibold">
        Calls
      </h2>
      {list.isError && <Alert>{list.error.message}</Alert>}
      {note && (
        <p role="status" className="text-sm text-muted">
          {note}
        </p>
      )}
      {list.data && calls.length === 0 && <p className="text-sm text-muted">No calls yet.</p>}
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-sm">
        {calls.map((c) => {
          const other = otherParty(c);
          const known = nameOf(other.number);
          return (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="w-36 text-muted">{new Date(c.startedAt).toLocaleString()}</span>
              <span className="w-10">{c.myRole === 'out' ? 'Out' : 'In'}</span>
              <span
                className={`min-w-0 flex-1 ${c.missedByMe ? 'font-semibold text-red-700 dark:text-red-400' : ''}`}
              >
                {(known ?? other.name) && <span>{known ?? other.name} </span>}
                {other.number ? (
                  <button
                    type="button"
                    className="text-link underline"
                    aria-label={`Call back ${fmtNumber(other.number)}`}
                    onClick={() => call(other.number!)}
                  >
                    {fmtNumber(other.number)}
                  </button>
                ) : (
                  'Unknown'
                )}
                {c.direction !== 'internal' && (
                  <span className="text-muted"> · {DIRECTION_TEXT[c.direction]}</span>
                )}
                {!known && other.number && c.direction !== 'internal' && (
                  <AddToContacts number={other.number} name={other.name} />
                )}
                {c.myRole === 'in' && !known && <SpamNote check={c.spam} />}
              </span>
              {c.recordingId && (
                <audio
                  controls
                  preload="none"
                  src={recordingsApi.audioUrl(c.recordingId)}
                  aria-label="Play the recording"
                  className="h-8 w-48"
                />
              )}
              <StatusBadge status={c.status} />
              <span className="w-12 text-right tabular-nums">{fmtDuration(c.talkSeconds)}</span>
            </li>
          );
        })}
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
