// SPDX-License-Identifier: AGPL-3.0-or-later
import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { toggleTheme } from '../theme.ts';
import { Button } from './ui.tsx';

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  return (
    <Button
      variant="ghost"
      aria-pressed={dark}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setDark(toggleTheme())}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
