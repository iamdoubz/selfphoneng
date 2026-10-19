// Apply the theme before first paint so dark mode doesn't flash. A file, not inline: the
// Content-Security-Policy allows only scripts from this origin (08 §2.4).
/* global matchMedia, document */
try {
  const t = localStorage.getItem('theme');
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches))
    document.documentElement.classList.add('dark');
} catch {
  // no storage (private window): the light default
}
