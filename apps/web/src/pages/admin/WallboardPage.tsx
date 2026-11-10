// SPDX-License-Identifier: AGPL-3.0-or-later
// Wallboard (16 §3): every queue on one big screen: who's waiting, the agents (with their break
// and how long), and today's numbers. Live from the socket; today's numbers every 30 s.
import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link } from 'react-router';
import type { QueueDto, QueueLive, QueueStats } from '@selfphoneng/shared';
import { extensionsApi, queuesApi } from '../../api/client.ts';
import { Alert, Button } from '../../components/ui.tsx';
import { subscribeLive, useLive } from '../../live/store.ts';
import { available, since, useNow } from './DashboardPage.tsx';

type Member = QueueLive['members'][number];

const BUSY = new Set(['inuse', 'busy', 'onhold', 'ringinuse']);
/** What an agent is doing, and how the row is tinted. */
function status(m: Member, now: number): { text: string; tone: 'free' | 'busy' | 'away' | 'off' } {
  if (m.paused) {
    const t = m.pausedSince ? ` · ${since(m.pausedSince, now)}` : '';
    return { text: `${m.pausedReason ?? 'Not taking calls'}${t}`, tone: 'away' };
  }
  if (m.state === 'idle') return { text: 'Free', tone: 'free' };
  if (m.state === 'ringing') return { text: 'Ringing', tone: 'busy' };
  if (BUSY.has(m.state)) return { text: 'On a call', tone: 'busy' };
  return { text: 'Offline', tone: 'off' };
}

const TONE = {
  free: 'text-green-700 dark:text-green-400',
  busy: 'text-link',
  away: 'text-amber-700 dark:text-amber-400',
  off: 'text-muted',
};

function Big({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-sm text-muted">{label}</dt>
      <dd
        className={`text-4xl font-semibold tabular-nums sm:text-5xl ${
          alert ? 'text-red-600 dark:text-red-400' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function QueueCard({
  q,
  live,
  stats,
  names,
  now,
}: {
  q: QueueDto;
  live: QueueLive | undefined;
  stats: QueueStats | undefined;
  names: Map<string, string>;
  now: number;
}) {
  const waiting = live?.waiting ?? [];
  const oldest = waiting.reduce<string | null>(
    (m, w) => (m === null || w.since < m ? w.since : m),
    null,
  );
  // Past the queue's "answered in time" target: the wait turns red.
  const late = oldest !== null && now - Date.parse(oldest) > q.slaSeconds * 1000;
  const members = live?.members ?? [];
  return (
    <li className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-lg font-semibold">
        <span className="font-mono text-muted">{q.number}</span> {q.name}
      </h2>
      <dl className="grid grid-cols-3 gap-3">
        <Big label="Waiting" value={String(waiting.length)} alert={late} />
        <Big label="Longest wait" value={oldest ? since(oldest, now) : '—'} alert={late} />
        <Big label="Agents free" value={live ? `${available(live)}/${members.length}` : '—'} />
      </dl>
      <dl aria-label="Today" className="grid grid-cols-4 gap-3 text-sm">
        {(
          [
            ['Calls today', stats?.offered],
            ['Answered', stats?.answered],
            ['Hung up waiting', stats?.abandoned],
            [
              `Answered in ${q.slaSeconds} s`,
              stats?.withinSlaPercent == null ? undefined : `${stats.withinSlaPercent}%`,
            ],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <dt className="text-muted">{k}</dt>
            <dd className="text-xl font-medium tabular-nums">{v ?? '—'}</dd>
          </div>
        ))}
      </dl>
      {members.length === 0 ? (
        <p className="text-sm text-muted">No agents.</p>
      ) : (
        <ul aria-label={`Agents of ${q.name}`} className="divide-y divide-line text-sm">
          {members.map((m) => {
            const s = status(m, now);
            return (
              <li key={m.ext} className="flex items-center gap-3 py-1.5">
                <span className="w-12 font-mono text-muted">{m.ext}</span>
                <span className="min-w-0 flex-1 truncate">{names.get(m.ext) ?? ''}</span>
                <span className={`font-medium tabular-nums ${TONE[s.tone]}`}>{s.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function WallboardPage() {
  useEffect(subscribeLive, []);
  const now = useNow();
  const live = useLive((s) => s.queues);
  const connected = useLive((s) => s.status === 'open');
  const queues = useQuery({ queryKey: ['queues'], queryFn: queuesApi.list });
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const stats = useQueries({
    queries: (queues.data ?? []).map((q) => ({
      queryKey: ['queues', q.id, 'stats'],
      queryFn: () => queuesApi.stats(q.id),
      refetchInterval: 30_000,
    })),
  });
  const names = new Map((exts.data ?? []).map((e) => [e.number, e.name]));
  return (
    <main className="flex min-h-dvh flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Queues</h1>
        <div className="flex items-center gap-3">
          <time className="text-2xl font-medium tabular-nums">
            {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
          <Button
            onClick={() =>
              void (document.fullscreenElement
                ? document.exitFullscreen()
                : document.documentElement.requestFullscreen())
            }
          >
            Full screen
          </Button>
          <Link className="text-sm text-muted hover:underline" to="/admin/queues">
            Back to admin
          </Link>
        </div>
      </header>
      {!connected && (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
          Connecting… the numbers may be out of date.
        </p>
      )}
      {queues.isError && <Alert>{queues.error.message}</Alert>}
      {queues.data?.length === 0 && (
        <p className="text-sm text-muted">
          No queues yet.{' '}
          <Link className="underline" to="/admin/queues">
            Add one
          </Link>
          .
        </p>
      )}
      <ul className="grid flex-1 grid-cols-1 content-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {queues.data?.map((q, i) => (
          <QueueCard
            key={q.id}
            q={q}
            live={live[q.number]}
            stats={stats[i]?.data}
            names={names}
            now={now}
          />
        ))}
      </ul>
    </main>
  );
}
