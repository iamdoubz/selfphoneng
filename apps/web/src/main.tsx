// SPDX-License-Identifier: AGPL-3.0-or-later
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { RequireAuth, homeFor } from './auth/RequireAuth.tsx';
import { ChangePasswordPage } from './pages/ChangePasswordPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { ADMIN_PAGES, AdminLayout, ComingSoon } from './pages/admin/AdminLayout.tsx';
import { UsersPage } from './pages/admin/UsersPage.tsx';
import { DashboardPage } from './pages/admin/DashboardPage.tsx';
import { TrunksPage } from './pages/admin/TrunksPage.tsx';
import { NumbersPage } from './pages/admin/NumbersPage.tsx';
import { OutboundPage } from './pages/admin/OutboundPage.tsx';
import { SettingsPage } from './pages/admin/SettingsPage.tsx';
import { SoundsPage } from './pages/admin/SoundsPage.tsx';
import { RingGroupsPage } from './pages/admin/RingGroupsPage.tsx';
import { QueuesPage } from './pages/admin/QueuesPage.tsx';
import { ConferencesPage } from './pages/admin/ConferencesPage.tsx';
import { PagingPage } from './pages/admin/PagingPage.tsx';
import { PhonesPage } from './pages/admin/PhonesPage.tsx';
import { AccountPage } from './pages/admin/AccountPage.tsx';
import { IvrsPage } from './pages/admin/IvrsPage.tsx';
import { OfficeHoursPage } from './pages/admin/OfficeHoursPage.tsx';
import { BlockedPage } from './pages/admin/BlockedPage.tsx';
import { CallsPage } from './pages/admin/CallsPage.tsx';
import { RecordingsPage } from './pages/admin/RecordingsPage.tsx';
import { ReportsPage } from './pages/admin/ReportsPage.tsx';
import { SystemPage } from './pages/admin/SystemPage.tsx';
import { MePage } from './pages/user/MePage.tsx';
import { SetupPage } from './pages/SetupPage.tsx';
import './index.css';

const router = createBrowserRouter([
  { path: '/login', Component: LoginPage },
  { path: '/change-password', Component: ChangePasswordPage },
  { path: '/setup', element: <RequireAuth role="admin">{() => <SetupPage />}</RequireAuth> },
  {
    path: '/admin',
    element: <RequireAuth role="admin">{(user) => <AdminLayout user={user} />}</RequireAuth>,
    children: [
      ...ADMIN_PAGES.map((p) => ({
        ...(p.path ? { path: p.path } : { index: true }),
        element:
          p.path === '' ? (
            <DashboardPage />
          ) : p.path === 'users' ? (
            <RequireAuth>{(user) => <UsersPage currentUserId={user.id} />}</RequireAuth>
          ) : p.path === 'settings' ? (
            <SettingsPage />
          ) : p.path === 'outbound' ? (
            <OutboundPage />
          ) : p.path === 'numbers' ? (
            <NumbersPage />
          ) : p.path === 'trunks' ? (
            <TrunksPage />
          ) : p.path === 'sounds' ? (
            <SoundsPage />
          ) : p.path === 'ring-groups' ? (
            <RingGroupsPage />
          ) : p.path === 'queues' ? (
            <QueuesPage />
          ) : p.path === 'conferences' ? (
            <ConferencesPage />
          ) : p.path === 'paging' ? (
            <PagingPage />
          ) : p.path === 'devices' ? (
            <PhonesPage />
          ) : p.path === 'ivrs' ? (
            <IvrsPage />
          ) : p.path === 'hours' ? (
            <OfficeHoursPage />
          ) : p.path === 'blocked' ? (
            <BlockedPage />
          ) : p.path === 'calls' ? (
            <CallsPage />
          ) : p.path === 'recordings' ? (
            <RecordingsPage />
          ) : p.path === 'reports' ? (
            <ReportsPage />
          ) : p.path === 'system' ? (
            <SystemPage />
          ) : (
            <ComingSoon label={p.label} milestone={p.milestone ?? ''} />
          ),
      })),
      { path: 'settings/:tab', element: <SettingsPage /> },
      { path: 'queues/:id', element: <QueuesPage /> },
      { path: 'account', element: <AccountPage /> },
    ],
  },
  { path: '/me/*', element: <RequireAuth>{(user) => <MePage user={user} />}</RequireAuth> },
  {
    path: '*',
    element: <RequireAuth>{(user) => <Navigate to={homeFor(user)} replace />}</RequireAuth>,
  },
]);

const queryClient = new QueryClient();

document.body.className = 'bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
