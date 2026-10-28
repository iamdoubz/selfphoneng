// SPDX-License-Identifier: AGPL-3.0-or-later
// Admin shell (05 §2): sidebar grouped by section; unbuilt pages say which milestone brings them.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AudioLines,
  Ban,
  BellRing,
  BookUser,
  Cable,
  ChartColumn,
  Clock,
  Hash,
  Headset,
  HistoryIcon,
  LayoutDashboard,
  Menu,
  ListOrdered,
  Megaphone,
  MessageSquare,
  MonitorSmartphone,
  Music,
  PhoneOutgoing,
  Settings,
  Split,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useNavigate } from 'react-router';
import type { AuthUser } from '@selfphoneng/shared';
import { signOut, systemApi } from '../../api/client.ts';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';
import { Brand, Button } from '../../components/ui.tsx';
import { subscribeLive, useLive } from '../../live/store.ts';

// Grouped by job rather than spec order, so the 21 pages scan as six short lists.
export const ADMIN_PAGES = [
  { path: '', label: 'Dashboard', milestone: null, section: '', icon: LayoutDashboard },
  { path: 'trunks', label: 'Trunks', milestone: null, section: 'Call routing', icon: Cable },
  { path: 'numbers', label: 'Phone numbers', milestone: null, section: 'Call routing', icon: Hash },
  {
    path: 'outbound',
    label: 'Outbound rules',
    milestone: null,
    section: 'Call routing',
    icon: PhoneOutgoing,
  },
  {
    path: 'ring-groups',
    label: 'Ring groups',
    milestone: null,
    section: 'Call routing',
    icon: BellRing,
  },
  { path: 'queues', label: 'Queues', milestone: null, section: 'Call routing', icon: ListOrdered },
  {
    path: 'ivrs',
    label: 'Digital receptionist',
    milestone: null,
    section: 'Call routing',
    icon: Split,
  },
  { path: 'hours', label: 'Office hours', milestone: null, section: 'Call routing', icon: Clock },
  {
    path: 'blocked',
    label: 'Blocked numbers',
    milestone: null,
    section: 'Call routing',
    icon: Ban,
  },
  { path: 'users', label: 'Users & Extensions', milestone: null, section: 'People', icon: Users },
  { path: 'devices', label: 'Phones', milestone: null, section: 'People', icon: MonitorSmartphone },
  { path: 'contacts', label: 'Contacts', milestone: null, section: 'People', icon: BookUser },
  {
    path: 'conferences',
    label: 'Conferences',
    milestone: null,
    section: 'Features',
    icon: Headset,
  },
  { path: 'paging', label: 'Paging', milestone: null, section: 'Features', icon: Megaphone },
  { path: 'sounds', label: 'Sounds & music', milestone: null, section: 'Features', icon: Music },
  { path: 'sms', label: 'SMS', milestone: 'M9', section: 'Features', icon: MessageSquare },
  { path: 'calls', label: 'Call history', milestone: null, section: 'History', icon: HistoryIcon },
  {
    path: 'recordings',
    label: 'Recordings',
    milestone: null,
    section: 'History',
    icon: AudioLines,
  },
  { path: 'reports', label: 'Reports', milestone: null, section: 'History', icon: ChartColumn },
  { path: 'settings', label: 'Settings', milestone: null, section: 'System', icon: Settings },
  { path: 'system', label: 'System', milestone: null, section: 'System', icon: Activity },
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
    await signOut(); // may leave for the OpenID provider's sign-out page (12 §3.5)
    qc.clear();
    nav('/login', { replace: true });
  }

  if (setup.data && !setup.data.completed) return <Navigate to="/setup" replace />;

  const links = (
    <nav aria-label="Admin" className="flex-1 overflow-y-auto px-2 pb-4">
      {[...new Set(ADMIN_PAGES.map((p) => p.section))].map((section) => (
        <div key={section} className="mt-3 first:mt-0">
          {section && (
            <h2 className="px-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">
              {section}
            </h2>
          )}
          <ul className="flex flex-col gap-0.5">
            {ADMIN_PAGES.filter((p) => p.section === section).map((p) => (
              <li key={p.path}>
                <NavLink
                  to={`/admin${p.path ? `/${p.path}` : ''}`}
                  end={p.path === ''}
                  onClick={() => setNavOpen(false)}
                  className={({ isActive }) =>
                    `relative flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm pointer-coarse:py-2.5 ${isActive ? 'bg-primary-soft font-medium text-primary-ink before:absolute before:inset-y-1.5 before:left-0 before:w-1 before:rounded-full before:bg-primary' : 'hover:bg-subtle'} ${p.milestone ? 'text-muted' : ''}`
                  }
                >
                  <p.icon className="size-4 shrink-0" />
                  <span className="flex-1">{p.label}</span>
                  {p.milestone && <span className="text-xs text-muted">{p.milestone}</span>}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 flex-col border-r border-line bg-surface md:flex">
        <p className="px-4 py-4 text-lg">
          <Brand />
        </p>
        {links}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-1 border-b border-line px-2 py-2 sm:gap-2 sm:px-4">
          <Button
            variant="ghost"
            className="md:hidden"
            aria-expanded={navOpen}
            aria-controls="mobile-nav"
            aria-label="Menu"
            onClick={() => setNavOpen((o) => !o)}
          >
            <Menu className="size-5" />
          </Button>
          <Brand className="md:hidden" />
          <div className="ml-auto flex items-center gap-1 whitespace-nowrap sm:gap-2">
            <span className="hidden text-sm text-muted sm:inline">{user.displayName}</span>
            <ThemeToggle />
            {/* On phones this lives in the menu instead. */}
            <span className="hidden sm:contents">
              <Button variant="ghost" onClick={() => nav('/admin/account')}>
                Account
              </Button>
            </span>
            <Button variant="ghost" onClick={logout}>
              Sign out
            </Button>
          </div>
        </header>
        {navOpen && (
          <div id="mobile-nav" className="border-b border-line bg-surface pt-2 md:hidden">
            {links}
            <div className="border-t border-line px-2 py-2">
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => nav('/admin/account')}
              >
                My account
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
      <p className="text-sm text-muted">Coming in {milestone}.</p>
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
