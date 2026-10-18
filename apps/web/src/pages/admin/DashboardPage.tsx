// SPDX-License-Identifier: AGPL-3.0-or-later
// Dashboard (05 §2). Telephony link, trunks and extensions online. Calls, queues and the
// warnings banner arrive with their features (M3-T4, M7, M8).
import type { ReactNode } from 'react';
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
