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
import { DndSwitch, MeSettingsPage, showTarget, useMe } from './MeSettingsPage.tsx';

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
  // *78/*79 or *72 from the desk phone: refresh my settings when my presence changes.
  const myDnd = useLive((s) => (me ? s.extensions[me]?.dnd : undefined));
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['me', 'settings'] });
  }, [myDnd, qc]);
  const toasts = useLive((s) => s.toasts);

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
        <NavLink to="/me/settings" className={tab}>
          Settings
        </NavLink>
        {/* People is a right-hand column on wide screens, a tab on small ones (05 §4.1). */}
        <NavLink to="/me/people" className={(s) => `${tab(s)} lg:hidden`}>
          People
        </NavLink>
      </nav>
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="flex items-start gap-2 rounded-md bg-amber-100 p-3 text-sm text-amber-900 dark:bg-amber-900 dark:text-amber-100"
        >
          <span className="flex-1">{t.message}</span>
          <Button
            variant="ghost"
            className="px-2 py-0"
            aria-label="Dismiss"
            onClick={() =>
              useLive.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))
            }
          >
            ✕
          </Button>
        </div>
      ))}
      <div className="grid flex-1 gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Routes>
            <Route index element={<Home user={user} />} />
            <Route path="voicemail" element={<VoicemailPage />} />
            <Route path="settings" element={<MeSettingsPage />} />
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
      {user.extension && <StatusCard />}
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

/** Do not disturb and forwarding at a glance (05 §4 Home). */
function StatusCard() {
  const me = useMe();
  if (!me.data) return null;
  const fwd = [
    me.data.cfu && `all calls go to ${showTarget(me.data.cfu)}`,
    me.data.cfb && `busy → ${showTarget(me.data.cfb)}`,
    me.data.cfna && `no answer → ${showTarget(me.data.cfna)}`,
  ].filter(Boolean);
  return (
    <section
      aria-label="My status"
      className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <DndSwitch me={me.data} />
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {fwd.length ? `Forwarding: ${fwd.join(', ')}.` : 'Not forwarding.'}{' '}
        <Link className={link} to="/me/settings">
          Change
        </Link>
      </p>
    </section>
  );
}
