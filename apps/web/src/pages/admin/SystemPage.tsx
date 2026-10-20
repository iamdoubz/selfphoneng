// SPDX-License-Identifier: AGPL-3.0-or-later
// System (05 §2): telephony status and how to restart it.
// ponytail: the spec's generator runs, generated files, CLI views and audit log aren't here yet;
// the admin guide's troubleshooting page covers them from the server's shell.
import { useQuery } from '@tanstack/react-query';
import { systemApi } from '../../api/client.ts';
import { Alert } from '../../components/ui.tsx';

const RESTART = 'docker compose restart asterisk';

export function SystemPage() {
  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: systemApi.status,
    refetchInterval: 10_000,
  });
  const s = status.data;
  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-xl font-semibold">System</h1>
      {status.error && <Alert>{status.error.message}</Alert>}

      {s && (
        <dl aria-label="Status" className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <dt className="text-zinc-500">Telephony (Asterisk)</dt>
            <dd className="font-semibold">{s.ami.connected ? 'Running' : 'Not reachable'}</dd>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <dt className="text-zinc-500">Restart</dt>
            <dd className="font-semibold">{s.restartRequired ? 'Needed' : 'Not needed'}</dd>
          </div>
        </dl>
      )}
      {s?.restartRequired && (
        <p
          role="status"
          className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          The public IP, SIP ports or TLS changed. Telephony keeps using the old ones until it
          restarts.
        </p>
      )}

      <div className="flex flex-col gap-2 text-sm">
        <h2 className="text-base font-medium">Restarting telephony</h2>
        <p>
          On the server, in the folder SelfPhoneNG is installed in (where <code>.env</code> is),
          run:
        </p>
        <pre
          aria-label="Restart command"
          className="overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono dark:bg-zinc-900"
        >
          {RESTART}
        </pre>
        <ul className="list-disc pl-5 text-zinc-600 dark:text-zinc-400">
          <li>
            <strong>Calls in progress drop</strong>, so do it when nobody is on the phone.
          </li>
          <li>
            Phones and the trunk sign in again by themselves within a minute. This page shows
            &ldquo;Running&rdquo; and &ldquo;Not needed&rdquo; once it&apos;s back.
          </li>
          <li>The web app, voicemail and call history aren&apos;t affected.</li>
        </ul>
      </div>
    </section>
  );
}
