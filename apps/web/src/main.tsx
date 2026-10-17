// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { APP_NAME } from '@selfphoneng/shared';
import { toggleTheme } from './theme.ts';
import './index.css';

function Home() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-start gap-6 p-4 sm:p-8">
      <header className="flex w-full items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold sm:text-3xl">{APP_NAME}</h1>
        <button
          type="button"
          onClick={() => setDark(toggleTheme())}
          aria-pressed={dark}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {dark ? 'Light mode' : 'Dark mode'}
        </button>
      </header>
      <p className="text-zinc-600 dark:text-zinc-400">
        Open source, self-hosted business phone system.
      </p>
    </main>
  );
}

const router = createBrowserRouter([{ path: '*', Component: Home }]);

document.body.className = 'bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
