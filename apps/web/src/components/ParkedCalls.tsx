// SPDX-License-Identifier: AGPL-3.0-or-later
// Calls waiting in parking slots (701–720), live. Anyone picks one up by dialing its slot.
import { useLive } from '../live/store.ts';
import { fmtNumber } from '../pages/admin/CallsPage.tsx';
import { since, useNow } from '../pages/admin/DashboardPage.tsx';

export function ParkedCalls({ onPickUp }: { onPickUp?: (slot: string) => void }) {
  const parked = Object.values(useLive((s) => s.parked)).sort((a, b) =>
    a.slot.localeCompare(b.slot),
  );
  const now = useNow();
  return (
    <section aria-labelledby="parked-h" className="flex flex-col gap-2">
      <h2 id="parked-h" className="font-medium">
        Parked calls
      </h2>
      {parked.length === 0 ? (
        <p className="text-sm text-muted">
          None. Transfer a call to 700 to park it; dial the slot to pick it up.
        </p>
      ) : (
        <ul
          aria-label="Parked calls"
          className="divide-y divide-line rounded-xl border border-line bg-surface shadow-sm"
        >
          {parked.map((p) => (
            <li
              key={p.slot}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="w-10 font-mono font-semibold">{p.slot}</span>
              <span className="min-w-0 flex-1 truncate">
                {p.callerName ? `${p.callerName} ` : ''}
                <span className="text-muted">{fmtNumber(p.callerNumber)}</span>
                {p.parkedBy && <span className="text-muted"> · parked by {p.parkedBy}</span>}
              </span>
              <span className="font-mono tabular-nums">{since(p.since, now)}</span>
              {onPickUp && (
                <button
                  type="button"
                  className="rounded-md border border-line-strong bg-surface px-2 py-1"
                  onClick={() => onPickUp(p.slot)}
                >
                  Pick up {p.slot}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
