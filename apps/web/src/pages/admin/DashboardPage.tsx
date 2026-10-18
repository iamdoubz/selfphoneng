// SPDX-License-Identifier: AGPL-3.0-or-later
// Dashboard (05 §2). Warnings, telephony link, trunks, calls in progress (hang up / transfer)
// and extensions online. Queues and parked calls arrive with M8.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import type { ActiveCall } from '@selfphoneng/shared';
import { Link } from 'react-router';
import { liveApi, settingsApi } from '../../api/client.ts';
import { ConfirmDialog } from '../../components/Dialog.tsx';
import { Alert, Button, inputClass } from '../../components/ui.tsx';
import { fmtNumber } from './CallsPage.tsx';
import { StatusDot, statusLabel } from '../../components/StatusDot.tsx';
import { useLive } from '../../live/store.ts';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm text-zinc-500">{title}</h2>
      <div className="mt-1 text-2xl font-semibold">{children}</div>
    </div>
  );
}

export function DashboardPage() {
  const { status, amiConnected, extensions, trunks } = useLive();
  const trunkList = Object.values(trunks);
  const trunksUp = trunkList.filter((t) => t.registration === 'registered' || t.reachable).length;
  const list = Object.values(extensions).sort((a, b) => Number(a.number) - Number(b.number));
  const online = list.filter((e) => e.online).length;
  const onCall = list.filter((e) =>
    ['inuse', 'busy', 'onhold', 'ringinuse'].includes(e.state),
  ).length;

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <Warnings
        trunkDown={trunkList.some(
          (t) => t.registration === 'rejected' || (!t.reachable && t.registration !== 'registered'),
        )}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Extensions online">
          {status === 'connecting' ? '…' : `${online} / ${list.length}`}
        </Card>
        <Card title="Trunks up">
          {status === 'connecting'
            ? '…'
            : trunkList.length
              ? `${trunksUp} / ${trunkList.length}`
              : 'None'}
        </Card>
        <Card title="On a call">{status === 'connecting' ? '…' : onCall}</Card>
        <Card title="Telephony engine">
          <span
            className={
              amiConnected ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
            }
          >
            {status === 'connecting' ? '…' : amiConnected ? 'Connected' : 'Not connected'}
          </span>
        </Card>
      </div>

      <LiveCalls />

      <div>
        <h2 className="mb-2 font-medium">Extensions</h2>
        {list.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No extensions yet. Give a user a number under Users & Extensions.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {list.map((e) => (
              <li key={e.number} className="flex items-center gap-3 px-3 py-2 text-sm">
                <StatusDot ext={e} />
                <span className="w-14 font-mono">{e.number}</span>
                <span className="flex-1 truncate">{e.name}</span>
                <span className="text-zinc-500">{statusLabel(e)}</span>
                {e.contacts && (
                  <span className="hidden w-24 text-right text-zinc-500 sm:inline">
                    {e.contacts.length} device{e.contacts.length === 1 ? '' : 's'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Warnings({ trunkDown }: { trunkDown: boolean }) {
  const warnings = useQuery({
    queryKey: ['warnings'],
    queryFn: settingsApi.warnings,
    refetchInterval: 30_000,
  });
  const items = [
    ...(trunkDown
      ? [
          {
            code: 'trunk_down',
            message: 'A trunk is not connected to the provider.',
            link: '/admin/trunks',
          },
        ]
      : []),
    ...(warnings.data ?? []),
  ];
  if (!items.length) return null;
  return (
    <ul
      aria-label="Warnings"
      className="flex flex-col gap-1 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100"
    >
      {items.map((w) => (
        <li key={w.code}>
          {w.message}{' '}
          <Link to={w.link} className="font-medium underline">
            Fix
          </Link>
        </li>
      ))}
    </ul>
  );
}

const STATE_TEXT: Record<ActiveCall['state'], string> = {
  ringing: 'Ringing',
  talking: 'Talking',
  hold: 'On hold',
  queued: 'In a queue',
  ivr: 'In the menu',
  voicemail: 'Leaving voicemail',
  parked: 'Parked',
};

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const since = (iso: string, now: number) => {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Calls in progress, from the live socket (04 §5.1). */
function LiveCalls() {
  const calls = Object.values(useLive((s) => s.calls)).sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  const now = useNow();
  const [hangingUp, setHangingUp] = useState<ActiveCall | null>(null);
  const [transferTo, setTransferTo] = useState<Record<string, string>>({});
  const hangup = useMutation({
    mutationFn: (c: ActiveCall) => liveApi.hangup(c.linkedid),
    onSuccess: () => setHangingUp(null),
  });
  const transfer = useMutation({
    mutationFn: ({ c, target }: { c: ActiveCall; target: string }) =>
      liveApi.transfer(c.linkedid, target),
  });
  return (
    <div>
      <h2 className="mb-2 font-medium">Calls now ({calls.length})</h2>
      {transfer.error && <Alert>{transfer.error.message}</Alert>}
      {calls.length === 0 ? (
        <p className="text-sm text-zinc-500">No calls right now.</p>
      ) : (
        <ul
          aria-label="Calls now"
          className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800"
        >
          {calls.map((c) => (
            <li
              key={c.linkedid}
              data-linkedid={c.linkedid}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">{c.from.name ?? fmtNumber(c.from.number)}</span>
                {c.from.name && <span className="text-zinc-500"> {fmtNumber(c.from.number)}</span>}
                {' → '}
                {fmtNumber(c.to.number)}
                <span className="text-zinc-500">
                  {' '}
                  · {STATE_TEXT[c.state]} {since(c.answeredAt ?? c.startedAt, now)}
                  {c.recording && ' · recording'}
                </span>
                <span className="block font-mono text-xs text-zinc-500" data-channels>
                  {c.channels.join(' ')}
                </span>
              </span>
              <form
                className="flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const target = transferTo[c.linkedid]?.trim();
                  if (target) transfer.mutate({ c, target });
                }}
              >
                <label htmlFor={`xfer-${c.linkedid}`} className="sr-only">
                  Transfer to
                </label>
                <input
                  id={`xfer-${c.linkedid}`}
                  className={`${inputClass} w-24`}
                  inputMode="numeric"
                  placeholder="Ext"
                  value={transferTo[c.linkedid] ?? ''}
                  onChange={(e) => setTransferTo({ ...transferTo, [c.linkedid]: e.target.value })}
                />
                <Button type="submit">Transfer</Button>
              </form>
              <Button variant="danger" onClick={() => setHangingUp(c)}>
                Hang up
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={hangingUp !== null}
        title="Hang up this call?"
        message={
          <p>
            {hangingUp &&
              `${hangingUp.from.name ?? fmtNumber(hangingUp.from.number)} → ${fmtNumber(hangingUp.to.number)}`}
          </p>
        }
        confirmLabel="Hang up"
        busy={hangup.isPending}
        error={hangup.error?.message}
        onCancel={() => setHangingUp(null)}
        onConfirm={() => hangingUp && hangup.mutate(hangingUp)}
      />
    </div>
  );
}
