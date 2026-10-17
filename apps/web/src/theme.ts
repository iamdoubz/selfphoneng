// SPDX-License-Identifier: AGPL-3.0-or-later
// index.html applies the stored/OS theme before paint; this flips and remembers it.
export function toggleTheme(): boolean {
  const dark = document.documentElement.classList.toggle('dark');
  try {
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  } catch {
    // storage blocked (private mode): the toggle still works for this page view
  }
  return dark;
}
