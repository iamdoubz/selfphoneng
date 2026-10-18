// SPDX-License-Identifier: AGPL-3.0-or-later
// My Phone (05 §4). M4: Home and Voicemail. Calls, contacts, settings and the softphone follow
// with their milestones (M5–M7).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router';
import { APP_NAME, type AuthUser } from '@selfphoneng/shared';
import { authApi, meApi } from '../../api/client.ts';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';
import { Alert, Button } from '../../components/ui.tsx';
import { subscribeLive, useLive } from '../../live/store.ts';
import { SoftphoneDock } from '../../softphone/SoftphoneDock.tsx';
import { PresencePanel } from '../../softphone/PresencePanel.tsx';
import { VoicemailPage, callerOf, isNew, mmss } from './VoicemailPage.tsx';

const link = 'text-sky-700 underline dark:text-sky-400';

export function MePage({ user }: { user: AuthUser }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const me = user.extension?.number ?? null;
  useEffect(subscribeLive, []);
  const voicemailSeq = useLive((s) => s.voicemailSeq);
  useEffect(() => {
    if (voicemailSeq) void qc.invalidateQueries({ queryKey: ['me', 'voicemail'] });
  }, [voicemailSeq, qc]);

  const tab = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`;
  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{APP_NAME}</h1>
        <div className="flex items-center gap-2">
          {user.role === 'admin' && (
            <Link className={`${link} text-sm`} to="/admin">
              Admin
            </Link>
          )}
          <ThemeToggle />
          <Button
            variant="ghost"
            onClick={async () => {
              await authApi.logout().catch(() => undefined);
              qc.clear();
              nav('/login', { replace: true });
            }}
          >
            Sign out
          </Button>
        </div>
      </header>
      <nav
        aria-label="My phone"
        className="flex gap-1 border-b border-zinc-200 pb-2 dark:border-zinc-800"
      >
        <NavLink to="/me" end className={tab}>
          Home
        </NavLink>
        <NavLink to="/me/voicemail" className={tab}>
          Voicemail
        </NavLink>
        {/* People is a right-hand column on wide screens, a tab on small ones (05 §4.1). */}
        <NavLink to="/me/people" className={(s) => `${tab(s)} lg:hidden`}>
          People
        </NavLink>
      </nav>
      <div className="grid flex-1 gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Routes>
            <Route index element={<Home user={user} />} />
            <Route path="voicemail" element={<VoicemailPage />} />
            <Route path="people" element={<PresencePanel me={me} />} />
          </Routes>
          <SoftphoneDock />
        </div>
        <aside className="hidden lg:block">
          <PresencePanel me={me} />
        </aside>
      </div>
    </main>
  );
}

function Home({ user }: { user: AuthUser }) {
  const list = useQuery({ queryKey: ['me', 'voicemail'], queryFn: meApi.voicemail });
  const fresh = list.data?.filter(isNew) ?? [];
  return (
    <div className="flex flex-col gap-6">
      <p>Hi {user.displayName}.</p>
      <section aria-labelledby="new-vm" className="flex flex-col gap-2">
        <h2 id="new-vm" className="text-lg font-semibold">
          New voicemails
        </h2>
        {list.error && <Alert>{list.error.message}</Alert>}
        {list.data && fresh.length === 0 && <p className="text-sm text-zinc-500">None.</p>}
        <ul className="flex flex-col gap-1">
          {fresh.slice(0, 5).map((m) => (
            <li key={m.id} className="text-sm">
              <span className="font-semibold">{callerOf(m)}</span>{' '}
              <span className="text-zinc-500">
                {new Date(m.receivedAt).toLocaleString()} · {mmss(m.durationS)}
              </span>
            </li>
          ))}
        </ul>
        {list.data && list.data.length > 0 && (
          <Link className={`${link} text-sm`} to="/me/voicemail">
            Open voicemail
          </Link>
        )}
      </section>
      <p className="text-sm">
        <Link className={link} to="/change-password">
          Change password
        </Link>
      </p>
    </div>
  );
}
