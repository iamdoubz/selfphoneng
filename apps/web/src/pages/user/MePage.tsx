// SPDX-License-Identifier: AGPL-3.0-or-later
// My Phone (05 §4) arrives in M4/M5; for now a signed-in landing page for non-admins.
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { APP_NAME, type AuthUser } from '@selfphoneng/shared';
import { authApi } from '../../api/client.ts';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';
import { Button } from '../../components/ui.tsx';

export function MePage({ user }: { user: AuthUser }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{APP_NAME}</h1>
        <div className="flex items-center gap-2">
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
      <p>
        Hi {user.displayName}. Voicemail, call history and the browser softphone are coming in
        M4–M5.
      </p>
      <p className="flex gap-4 text-sm">
        <Link className="text-sky-700 underline dark:text-sky-400" to="/change-password">
          Change password
        </Link>
        {user.role === 'admin' && (
          <Link className="text-sky-700 underline dark:text-sky-400" to="/admin">
            Admin
          </Link>
        )}
      </p>
    </main>
  );
}
