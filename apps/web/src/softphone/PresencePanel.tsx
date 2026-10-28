// SPDX-License-Identifier: AGPL-3.0-or-later
// Presence panel (05 §4.1): everyone's status, search, click to call. During a call: transfer
// (blind), talk first (attended), or drag the call card onto a person (blind).
import { useState } from 'react';
import type { ExtensionLive } from '@selfphoneng/shared';
import { meApi } from '../api/client.ts';
import { StatusDot, statusLabel } from '../components/StatusDot.tsx';
import { Button, inputClass } from '../components/ui.tsx';
import { useLive } from '../live/store.ts';
import { useSoftphone } from './useSoftphone.ts';
import { CALL_DRAG, softphone } from './SoftphoneEngine.ts';

export function PresencePanel({ me }: { me: string | null }) {
  const exts = useLive((s) => s.extensions);
  const { reg, calls } = useSoftphone();
  const [q, setQ] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const active = calls.find((c) => c.state === 'active' && !c.held);
  const query = q.trim().toLowerCase();
  const people = Object.values(exts)
    .filter((e) => e.number !== me)
    .filter((e) => !query || e.name.toLowerCase().includes(query) || e.number.includes(query))
    .sort((a, b) => Number(a.number) - Number(b.number));

  const run = (p: Promise<unknown>, ok?: string) => {
    setNote(null);
    p.then(
      () => ok && setNote(ok),
      (e: Error) => setNote(e.message),
    );
  };
  // The softphone when it's on; otherwise the desk phone rings first (click-to-call).
  const call = (e: ExtensionLive) =>
    reg === 'registered'
      ? run(softphone.call(e.number))
      : run(
          meApi.clickToCall(e.number),
          `Your desk phone is ringing. Pick it up to call ${e.name}.`,
        );

  return (
    <section aria-labelledby="people-h" className="flex flex-col gap-2">
      <h2 id="people-h" className="text-lg font-semibold">
        People
      </h2>
      <label htmlFor="people-q" className="sr-only">
        Search people
      </label>
      <input
        id="people-q"
        className={inputClass}
        placeholder="Search people"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {note && (
        <p role="status" className="text-sm text-muted">
          {note}
        </p>
      )}
      <ul className="flex flex-col">
        {people.map((e) => (
          <li
            key={e.number}
            data-number={e.number}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-subtle"
            onDragOver={(ev) => {
              if (active && ev.dataTransfer.types.includes(CALL_DRAG)) ev.preventDefault();
            }}
            onDrop={(ev) => {
              const id = ev.dataTransfer.getData(CALL_DRAG);
              if (id) run(softphone.blindTransfer(id, e.number));
            }}
          >
            <StatusDot ext={e} />
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="font-medium">{e.name}</span>{' '}
              <span className="text-muted">
                {e.number} · {statusLabel(e)}
              </span>
            </span>
            {active ? (
              <>
                <Button
                  className="px-2 py-1"
                  aria-label={`Transfer to ${e.name}`}
                  onClick={() => run(softphone.blindTransfer(active.id, e.number))}
                >
                  Transfer
                </Button>
                <Button
                  className="px-2 py-1"
                  aria-label={`Talk to ${e.name} first`}
                  onClick={() => run(softphone.call(e.number))}
                >
                  Talk first
                </Button>
              </>
            ) : (
              <Button
                className="px-2 py-1"
                aria-label={`Call ${e.name}`}
                disabled={calls.length >= 2}
                onClick={() => call(e)}
              >
                Call
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
