// SPDX-License-Identifier: AGPL-3.0-or-later
// My Phone (05 §4): Home, Calls, Voicemail, Contacts (11), Settings, People, and the softphone.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router';
import type { AuthUser } from '@selfphoneng/shared';
import { meApi, signOut } from '../../api/client.ts';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';
import { Alert, Brand, Button, MenuIcon } from '../../components/ui.tsx';
import { subscribeLive, useLive } from '../../live/store.ts';
import { SoftphoneDock } from '../../softphone/SoftphoneDock.tsx';
import { PresencePanel } from '../../softphone/PresencePanel.tsx';
import { VoicemailPage, callerOf, isNew, mmss } from './VoicemailPage.tsx';
import { MyCallsPage, otherParty, useCallBack } from './MyCallsPage.tsx';
import { fmtNumber } from '../admin/CallsPage.tsx';
import { ParkedCalls } from '../../components/ParkedCalls.tsx';
import { DndSwitch, MeSettingsPage, showTarget, useMe } from './MeSettingsPage.tsx';
import { ContactsPage, useContactName, useContactShares } from './ContactsPage.tsx';

const link = 'text-link underline';

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
  const offers = useContactShares().data?.length ?? 0;

  const [menu, setMenu] = useState(false);
  const close = () => setMenu(false);
  async function logout() {
    await signOut(); // may leave for the OpenID provider's sign-out page (12 §3.5)
    qc.clear();
    nav('/login', { replace: true });
  }

  const tab = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-2 text-sm font-medium pointer-coarse:py-3 ${isActive ? 'bg-subtle' : 'hover:bg-subtle'}`;
  const row = tab({ isActive: false });
  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-xl">
          <Brand />
        </h1>
        <div className="hidden items-center gap-2 md:flex">
          {user.role === 'admin' && (
            <Link className={`${link} text-sm`} to="/admin">
              Admin
            </Link>
          )}
          <Link className={`${link} text-sm`} to="/about">
            About
          </Link>
          <ThemeToggle />
          <Button variant="ghost" onClick={logout}>
            Sign out
          </Button>
        </div>
        <Button
          variant="ghost"
          className="relative md:hidden"
          aria-expanded={menu}
          aria-controls="me-nav"
          aria-label={offers > 0 ? `Menu, ${offers} shared with you` : 'Menu'}
          onClick={() => setMenu((o) => !o)}
        >
          <MenuIcon />
          {offers > 0 && (
            <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary" />
          )}
        </Button>
      </header>
      {/* On phones the tabs and the header links fold into the menu button. */}
      <nav
        id="me-nav"
        aria-label="My phone"
        className={`${menu ? 'flex' : 'hidden'} flex-col gap-1 border-b border-line pb-2 md:flex md:flex-row`}
      >
        <NavLink to="/me" end className={tab} onClick={close}>
          Home
        </NavLink>
        <NavLink to="/me/calls" className={tab} onClick={close}>
          Calls
        </NavLink>
        <NavLink to="/me/voicemail" className={tab} onClick={close}>
          Voicemail
        </NavLink>
        <NavLink to="/me/contacts" className={tab} onClick={close}>
          Contacts
          {offers > 0 && (
            <span className="ml-1 rounded-full bg-primary px-1.5 text-xs text-white">
              <span className="sr-only">, shared with you: </span>
              {offers}
            </span>
          )}
        </NavLink>
        <NavLink to="/me/settings" className={tab} onClick={close}>
          Settings
        </NavLink>
        {/* People is a right-hand column on wide screens, a tab on small ones (05 §4.1). */}
        <NavLink to="/me/people" className={(s) => `${tab(s)} lg:hidden`} onClick={close}>
          People
        </NavLink>
        <div className="mt-1 flex flex-col gap-1 border-t border-line pt-2 md:hidden">
          {user.role === 'admin' && (
            <Link className={row} to="/admin">
              Admin
            </Link>
          )}
          <Link className={row} to="/about">
            About
          </Link>
          <div className="flex items-center justify-between pl-3 text-sm font-medium">
            Theme
            <ThemeToggle />
          </div>
          <button type="button" className={`${row} text-left`} onClick={logout}>
            Sign out
          </button>
        </div>
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
            <Route path="calls" element={<MyCallsPage />} />
            <Route path="voicemail" element={<VoicemailPage />} />
            <Route path="contacts" element={<ContactsPage />} />
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
  const nameOf = useContactName();
  return (
    <div className="flex flex-col gap-6">
      <p>Hi {user.displayName}.</p>
      <SharedNotice />
      {user.extension && <StatusCard ext={user.extension.number} />}
      {user.extension && <MissedCalls />}
      {user.extension && <ParkedOnHome />}
      <section aria-labelledby="new-vm" className="flex flex-col gap-2">
        <h2 id="new-vm" className="text-lg font-semibold">
          New voicemails
        </h2>
        {list.error && <Alert>{list.error.message}</Alert>}
        {list.data && fresh.length === 0 && <p className="text-sm text-muted">None.</p>}
        <ul className="flex flex-col gap-1">
          {fresh.slice(0, 5).map((m) => (
            <li key={m.id} className="text-sm">
              <span className="font-semibold">{nameOf(m.callerNumber) ?? callerOf(m)}</span>{' '}
              <span className="text-muted">
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

/** "Dan shared 2 contacts with you": they wait in Contacts for Accept or Deny (11 §2.1). */
function SharedNotice() {
  const offers = useContactShares().data ?? [];
  if (!offers.length) return null;
  const from = [...new Set(offers.map((o) => o.from?.name ?? 'Someone'))].join(', ');
  return (
    <p role="status" className="rounded-md bg-primary-soft p-3 text-sm">
      {from} shared {offers.length} contact{offers.length === 1 ? '' : 's'} with you.{' '}
      <Link className={link} to="/me/contacts">
        Accept or deny
      </Link>
    </p>
  );
}

/** Do not disturb and forwarding at a glance (05 §4 Home). */
function StatusCard({ ext }: { ext: string }) {
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
      className="flex flex-col gap-2 rounded-xl border border-line bg-surface shadow-sm p-4"
    >
      <DndSwitch me={me.data} />
      <QueueLogins ext={ext} />
      <p className="text-sm text-muted">
        {fwd.length ? `Forwarding: ${fwd.join(', ')}.` : 'Not forwarding.'}{' '}
        <Link className={link} to="/me/settings">
          Change
        </Link>
      </p>
    </section>
  );
}

/** One switch per queue I'm an agent of: on = logged in (not paused), like *45<queue>. */
function QueueLogins({ ext }: { ext: string }) {
  const queues = Object.values(useLive((s) => s.queues)).sort((a, b) =>
    a.number.localeCompare(b.number),
  );
  const toggle = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      meApi.setQueuePaused(id, paused),
  });
  return (
    <>
      {queues.map((q) => {
        const mine = q.members.find((m) => m.ext === ext);
        if (!mine) return null;
        return (
          <label key={q.number} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              role="switch"
              checked={!mine.paused}
              disabled={toggle.isPending}
              onChange={(e) => toggle.mutate({ id: q.id, paused: !e.target.checked })}
            />
            Taking calls from queue {q.name} ({q.number})
            <span className="text-xs text-muted">(also *45{q.number} from your phone)</span>
          </label>
        );
      })}
      {toggle.error && <Alert>{toggle.error.message}</Alert>}
    </>
  );
}

/** Parked calls with a Pick up button: my phone (or softphone) dials the slot. */
function ParkedOnHome() {
  const { call, note } = useCallBack();
  return (
    <div className="flex flex-col gap-1">
      <ParkedCalls onPickUp={call} />
      {note && (
        <p role="status" className="text-sm text-muted">
          {note}
        </p>
      )}
    </div>
  );
}

/** Missed calls from the last page of my history (05 §4 Home). */
function MissedCalls() {
  const calls = useQuery({ queryKey: ['me', 'calls', 'home'], queryFn: () => meApi.calls() });
  const { call, note } = useCallBack();
  const missed = calls.data?.items.filter((c) => c.missedByMe).slice(0, 5) ?? [];
  const nameOf = useContactName();
  return (
    <section aria-labelledby="missed-h" className="flex flex-col gap-2">
      <h2 id="missed-h" className="text-lg font-semibold">
        Missed calls
      </h2>
      {calls.data && missed.length === 0 && <p className="text-sm text-muted">None.</p>}
      {note && (
        <p role="status" className="text-sm text-muted">
          {note}
        </p>
      )}
      <ul className="flex flex-col gap-1 text-sm">
        {missed.map((c) => {
          const o = otherParty(c);
          return (
            <li key={c.id}>
              <span className="font-semibold">
                {nameOf(o.number) ?? o.name ?? fmtNumber(o.number)}
              </span>{' '}
              <span className="text-muted">{new Date(c.startedAt).toLocaleString()}</span>{' '}
              {o.number && (
                <button
                  type="button"
                  className={link}
                  onClick={() => call(o.number!)}
                  aria-label={`Call back ${fmtNumber(o.number)}`}
                >
                  Call back
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {calls.data && calls.data.items.length > 0 && (
        <Link className={`${link} text-sm`} to="/me/calls">
          All my calls
        </Link>
      )}
    </section>
  );
}
