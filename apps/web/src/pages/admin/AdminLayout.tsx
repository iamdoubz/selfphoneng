// SPDX-License-Identifier: AGPL-3.0-or-later
// Admin shell (05 §2): sidebar in spec order; unbuilt pages say which milestone brings them.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useNavigate } from 'react-router';
import { APP_NAME, type AuthUser } from '@selfphoneng/shared';
import { authApi, systemApi } from '../../api/client.ts';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';
import { Button } from '../../components/ui.tsx';
import { subscribeLive, useLive } from '../../live/store.ts';

export const ADMIN_PAGES = [
  { path: '', label: 'Dashboard', milestone: null },
  { path: 'users', label: 'Users & Extensions', milestone: null },
  { path: 'trunks', label: 'Trunks', milestone: null },
  { path: 'numbers', label: 'Phone numbers', milestone: null },
  { path: 'outbound', label: 'Outbound rules', milestone: null },
  { path: 'ring-groups', label: 'Ring groups', milestone: 'M6' },
  { path: 'queues', label: 'Queues', milestone: 'M8' },
  { path: 'ivrs', label: 'Digital receptionist', milestone: 'M6' },
  { path: 'hours', label: 'Office hours', milestone: 'M6' },
  { path: 'conferences', label: 'Conferences', milestone: 'M8' },
  { path: 'paging', label: 'Paging', milestone: 'M8' },
  { path: 'sounds', label: 'Sounds & music', milestone: 'M6' },
  { path: 'devices', label: 'Phones', milestone: 'M10' },
  { path: 'contacts', label: 'Contacts', milestone: 'M10' },
  { path: 'calls', label: 'Call history', milestone: 'M7' },
  { path: 'recordings', label: 'Recordings', milestone: 'M7' },
  { path: 'reports', label: 'Reports', milestone: 'M11' },
  { path: 'sms', label: 'SMS', milestone: 'M9' },
  { path: 'blocked', label: 'Blocked numbers', milestone: 'M6' },
  { path: 'settings', label: 'Settings', milestone: null },
  { path: 'system', label: 'System', milestone: 'M11' },
] as const;

export function AdminLayout({ user }: { user: AuthUser }) {
  const [navOpen, setNavOpen] = useState(false);
  const liveStatus = useLive((s) => s.status);
  useEffect(subscribeLive, []);
  const qc = useQueryClient();
  const nav = useNavigate();
  // The first-run wizard comes first until it's finished or skipped (05 §2.1).
  const setup = useQuery({ queryKey: ['setup'], queryFn: systemApi.setupStatus });

  async function logout() {
    await authApi.logout().catch(() => undefined);
    qc.clear();
    nav('/login', { replace: true });
  }

  if (setup.data && !setup.data.completed) return <Navigate to="/setup" replace />;

  const links = (
    <nav aria-label="Admin" className="flex-1 overflow-y-auto px-2 pb-4">
      <ul className="flex flex-col gap-0.5">
        {ADMIN_PAGES.map((p) => (
          <li key={p.path}>
            <NavLink
              to={`/admin${p.path ? `/${p.path}` : ''}`}
              end={p.path === ''}
              onClick={() => setNavOpen(false)}
              className={({ isActive }) =>
                `flex items-center justify-between rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-sky-100 font-medium text-sky-900 dark:bg-sky-950 dark:text-sky-100' : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-800'} ${p.milestone ? 'text-zinc-500' : ''}`
              }
            >
              {p.label}
              {p.milestone && <span className="text-[10px] text-zinc-400">{p.milestone}</span>}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 flex-col border-r border-zinc-200 bg-zinc-50 md:flex dark:border-zinc-800 dark:bg-zinc-900">
        <p className="px-4 py-4 text-lg font-semibold">{APP_NAME}</p>
        {links}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-1 border-b border-zinc-200 px-2 py-2 sm:gap-2 sm:px-4 dark:border-zinc-800">
          <Button
            variant="ghost"
            className="md:hidden"
            aria-expanded={navOpen}
            aria-controls="mobile-nav"
            aria-label="Menu"
            onClick={() => setNavOpen((o) => !o)}
          >
            ☰
          </Button>
          <span className="font-semibold md:hidden">{APP_NAME}</span>
          <div className="ml-auto flex items-center gap-1 whitespace-nowrap sm:gap-2">
            <span className="hidden text-sm text-zinc-600 sm:inline dark:text-zinc-400">
              {user.displayName}
            </span>
            <ThemeToggle />
            {/* On phones this lives in the menu instead. */}
            <span className="hidden sm:contents">
              <Button variant="ghost" onClick={() => nav('/change-password')}>
                Password
              </Button>
            </span>
            <Button variant="ghost" onClick={logout}>
              Sign out
            </Button>
          </div>
        </header>
        {navOpen && (
          <div
            id="mobile-nav"
            className="border-b border-zinc-200 bg-zinc-50 pt-2 md:hidden dark:border-zinc-800 dark:bg-zinc-900"
          >
            {links}
            <div className="border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => nav('/change-password')}
              >
                Change password
              </Button>
            </div>
          </div>
        )}
        {liveStatus === 'reconnecting' && (
          <p
            role="status"
            className="bg-amber-100 px-4 py-1 text-center text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          >
            Reconnecting…
          </p>
        )}
        <EmergencyBanner />
        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function ComingSoon({ label, milestone }: { label: string; milestone: string }) {
  return (
    <section>
      <h1 className="mb-2 text-xl font-semibold">{label}</h1>
      <p className="text-sm text-zinc-500">Coming in {milestone}.</p>
    </section>
  );
}

/** 911 was dialed: impossible to miss, stays until dismissed (04 §5.3). */
function EmergencyBanner() {
  const calls = useLive((s) => s.emergencies);
  if (!calls.length) return null;
  const dismiss = (at: string) =>
    useLive.setState((s) => ({ emergencies: s.emergencies.filter((c) => c.at !== at) }));
  return (
    <div role="alert" className="flex flex-col gap-1 bg-red-600 px-4 py-2 text-sm text-white">
      {calls.map((c) => (
        <div key={c.at + c.ext} className="flex flex-wrap items-center gap-x-3">
          <strong>
            {c.test
              ? `TEST of the 911 alerts (${c.name})`
              : `911 dialed from extension ${c.ext || '?'} (${c.name})`}
          </strong>
          <span>
            {new Date(c.at).toLocaleTimeString()}
            {c.location ? ` · ${c.location}` : ''}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => dismiss(c.at)}
            className="rounded border border-white/60 px-2 py-0.5 text-xs hover:bg-white/10"
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
