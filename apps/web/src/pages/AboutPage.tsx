// SPDX-License-Identifier: AGPL-3.0-or-later
// About (08 §4): license, the source of this exact build (AGPL-3.0 §13) and third-party credits.
// No sign-in: everyone who uses the system over the network gets the offer.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { aboutApi } from '../api/client.ts';
import { Alert, Brand } from '../components/ui.tsx';

const linkClass = 'text-link underline';

export function AboutPage() {
  const about = useQuery({ queryKey: ['about'], queryFn: aboutApi.get });
  const a = about.data;
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 p-4 text-sm sm:p-8">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-xl">
          <Brand />
        </h1>
        <Link to="/" className={linkClass}>
          Back
        </Link>
      </header>
      {about.error && <Alert>{about.error.message}</Alert>}

      <section aria-labelledby="license-h" className="flex flex-col gap-2">
        <h2 id="license-h" className="text-lg font-semibold">
          SelfPhoneNG {a && `v${a.version}`}
        </h2>
        <p>
          SelfPhoneNG is free software: you can redistribute it and change it under the terms of the{' '}
          <a className={linkClass} href="https://www.gnu.org/licenses/agpl-3.0.html">
            GNU Affero General Public License
          </a>
          , version 3 or (at your option) any later version. It comes with no warranty.
        </p>
        <p>
          Because you use it over a network, you&apos;re entitled to the source code of the version
          running here, changes included. Download it below: it&apos;s the exact source this system
          was built from.
        </p>
        {a?.source ? (
          <div className="flex flex-wrap items-center gap-3">
            <a
              href="/api/about/source"
              download="selfphone.tar.gz"
              className="rounded-md bg-primary px-4 py-2 font-medium text-white hover:bg-primary-hover"
            >
              Code v{a.version}
            </a>
            <span className="text-muted">
              selfphone.tar.gz, {Math.max(1, Math.round(a.source.bytes / 1e6))} MB, built{' '}
              {new Date(a.source.builtAt).toLocaleString()}
            </span>
          </div>
        ) : (
          a && (
            <p className="text-muted">
              This is a development build: the source archive is only in builds made with Docker.
              The project&apos;s repository is below.
            </p>
          )
        )}
        {a && (
          <p>
            Project home (all versions, issues):{' '}
            <a className={linkClass} href={a.repoUrl}>
              {a.repoUrl.replace(/^https:\/\//, '')}
            </a>
          </p>
        )}
      </section>

      <section aria-labelledby="credits-h" className="flex flex-col gap-2">
        <h2 id="credits-h" className="text-lg font-semibold">
          Built with
        </h2>
        <ul className="list-disc pl-5">
          <li>
            <a className={linkClass} href="https://www.asterisk.org/">
              Asterisk
            </a>{' '}
            (GPL-2.0), the telephony engine. It runs as a separate program.
          </li>
          <li>
            Asterisk&apos;s voice prompts (core and extra sounds), © Sangoma Technologies, under{' '}
            <a className={linkClass} href="https://creativecommons.org/licenses/by-sa/3.0/">
              CC BY-SA 3.0
            </a>
            .
          </li>
          <li>
            Default music on hold from opsound.org, under{' '}
            <a className={linkClass} href="https://creativecommons.org/licenses/by-sa/3.0/">
              CC BY-SA 3.0
            </a>
            .
          </li>
          <li>
            PostgreSQL, Node.js, Fastify, React, SIP.js and the other libraries listed in the
            source&apos;s package.json files, each under its own license.
          </li>
        </ul>
      </section>
    </main>
  );
}
