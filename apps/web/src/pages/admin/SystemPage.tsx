// SPDX-License-Identifier: AGPL-3.0-or-later
// System (05 §2): system information, how to restart telephony, and the event log.
// ponytail: the spec's generator runs, generated files, CLI views and audit log aren't here yet;
// the admin guide's troubleshooting page covers them from the server's shell.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { SystemEventDto } from '@selfphoneng/shared';
import { systemApi } from '../../api/client.ts';
import { Alert, Button } from '../../components/ui.tsx';

const RESTART = 'docker compose restart asterisk';

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" aria-hidden className="size-4 fill-none stroke-current stroke-2">
    <path d={d} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const INFO = 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01';
const LIST = 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01';
const DOWNLOAD = 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3';
const COPY = 'M8 8h12v12H8zM4 16V4h12';

function Panel({
  title,
  path,
  action,
  children,
}: {
  title: string;
  path: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <span className="text-sky-600 dark:text-sky-400">{icon(path)}</span>
        <h2 className="flex-1 font-medium">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={done ? 'Copied' : `Copy ${label}`}
      className="rounded p-0.5 text-sky-600 hover:bg-zinc-100 dark:text-sky-400 dark:hover:bg-zinc-800"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {icon(COPY)}
    </button>
  );
}

/** One "label value" cell of the information grid. */
function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-zinc-100 py-2 dark:border-zinc-800">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="flex items-center gap-1.5 font-semibold">{children}</dd>
    </div>
  );
}

const SEVERITY: Record<SystemEventDto['severity'], [string, string]> = {
  info: ['Info', 'bg-sky-500'],
  warning: ['Warning', 'bg-amber-500'],
  error: ['Error', 'bg-red-500'],
};

export function SystemPage() {
  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: systemApi.status,
    refetchInterval: 10_000,
  });
  const events = useInfiniteQuery({
    queryKey: ['system-events'],
    queryFn: ({ pageParam }) => systemApi.events(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.nextCursor ? Number(last.nextCursor) : undefined),
    refetchInterval: 30_000,
  });
  const s = status.data;
  const rows = events.data?.pages.flatMap((p) => p.items) ?? [];
  const p = s?.ports;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">System</h1>
        <Link to="/about" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
          About and source code
        </Link>
      </div>
      {status.error && <Alert>{status.error.message}</Alert>}

      <Panel title="System information" path={INFO}>
        {s && p && (
          <dl
            aria-label="Status"
            className="grid gap-x-8 px-4 pb-2 text-sm sm:grid-cols-2 xl:grid-cols-3"
          >
            <Item label="Version">v{s.version}</Item>
            <Item label="Host name">
              {s.hostname} <Copy text={s.hostname} label="host name" />
            </Item>
            <Item label="Company">{s.companyName}</Item>
            <Item label="Public IP">
              {s.publicIp ?? 'not set'}
              <span className="font-normal text-zinc-500">
                {s.publicIpDynamic ? 'dynamic, re-checked' : 'static'}
              </span>
              {s.publicIp && <Copy text={s.publicIp} label="public IP" />}
            </Item>
            <Item label="LAN IP">{s.lanIps.join(', ') || '–'}</Item>
            <Item label="Ports">
              <span>
                SIP {p.sip}
                <span className="font-normal text-zinc-500">{p.sipTcp ? ' UDP+TCP' : ' UDP'}</span>
                {p.sips && ` · SIPS ${p.sips}`} · Media {p.rtp} · HTTPS {p.https}
              </span>
            </Item>
            <Item label="Telephony">
              <span
                className={`size-2 rounded-full ${s.ami.connected ? 'bg-green-500' : 'bg-red-500'}`}
              />
              {s.ami.connected ? 'Running' : 'Not reachable'}
            </Item>
            <Item label="Restart">
              <span
                className={`size-2 rounded-full ${s.restartRequired ? 'bg-amber-500' : 'bg-green-500'}`}
              />
              {s.restartRequired ? 'Needed' : 'Not needed'}
            </Item>
          </dl>
        )}
        <div className="flex flex-col gap-2 px-4 py-3 text-sm">
          {s?.restartRequired && (
            <p
              role="status"
              className="rounded-md bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
            >
              The public IP, SIP ports or TLS changed. Telephony keeps using the old ones until it
              restarts.
            </p>
          )}
          <p>
            <strong>Restarting telephony:</strong> on the server, in the folder SelfPhoneNG is
            installed in (where <code>.env</code> is), run:
          </p>
          <div className="flex items-center gap-2">
            <pre
              aria-label="Restart command"
              className="flex-1 overflow-x-auto rounded-md bg-zinc-100 px-3 py-2 font-mono dark:bg-zinc-950"
            >
              {RESTART}
            </pre>
            <Copy text={RESTART} label="restart command" />
          </div>
          <p className="text-zinc-500">
            Calls in progress drop, so do it when nobody is on the phone. Phones and trunks sign in
            again by themselves within a minute; the web app, voicemail and history aren&apos;t
            affected.
          </p>
        </div>
      </Panel>

      <Panel
        title="Event log"
        path={LIST}
        action={
          <a
            href="/api/system/events.csv"
            className="flex items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {icon(DOWNLOAD)} Download
          </a>
        }
      >
        {events.error && <Alert>{events.error.message}</Alert>}
        {events.data && !rows.length && (
          <p className="px-4 py-3 text-sm text-zinc-500">Nothing logged yet.</p>
        )}
        {!!rows.length && (
          <div className="overflow-x-auto">
            <table aria-label="Events" className="w-full text-left text-sm">
              <thead className="text-zinc-500">
                <tr>
                  {['Severity', 'Event', 'Time', 'Source', 'Details'].map((h) => (
                    <th key={h} scope="col" className="px-4 py-2 font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-1.5 whitespace-nowrap">
                      <span className="flex items-center gap-1.5">
                        <span className={`size-2 rounded-full ${SEVERITY[e.severity][1]}`} />
                        {SEVERITY[e.severity][0]}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 font-mono text-xs whitespace-nowrap">{e.code}</td>
                    <td className="px-4 py-1.5 whitespace-nowrap tabular-nums">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-1.5 whitespace-nowrap">{e.source}</td>
                    <td className="min-w-64 px-4 py-1.5">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {events.hasNextPage && (
          <div className="border-t border-zinc-100 py-2 text-center dark:border-zinc-800">
            <Button
              onClick={() => void events.fetchNextPage()}
              disabled={events.isFetchingNextPage}
            >
              Load more
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}
