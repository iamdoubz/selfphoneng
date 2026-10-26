// SPDX-License-Identifier: AGPL-3.0-or-later
// Login failure limits (04 §2.2): 5 per IP per 15 min, 10 per email per hour.
// ponytail: in-process memory, resets on restart; fine for one api process (v1 has no HA).
const MIN = 60_000;
const RULES = { ip: { max: 5, windowMs: 15 * MIN }, email: { max: 10, windowMs: 60 * MIN } };
const LONGEST = Math.max(RULES.ip.windowMs, RULES.email.windowMs);

const failures = new Map<string, number[]>();
let lastSweep = 0;

function recent(key: string, windowMs: number, now: number): number[] {
  const list = (failures.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

/** `email` null: by IP only (an OpenID callback names no account, 12 §3.2). */
export function isLoginBlocked(ip: string, email: string | null, now = Date.now()): boolean {
  return (
    recent(`ip:${ip}`, RULES.ip.windowMs, now).length >= RULES.ip.max ||
    (email !== null &&
      recent(`email:${email.toLowerCase()}`, RULES.email.windowMs, now).length >= RULES.email.max)
  );
}

export function recordLoginFailure(ip: string, email: string | null, now = Date.now()): void {
  // Forget keys past every window, at most once a minute: emails tried once and never again
  // would otherwise stay until restart (08 §6).
  if (now - lastSweep > MIN) {
    lastSweep = now;
    for (const [key, list] of failures) if (now - list.at(-1)! >= LONGEST) failures.delete(key);
  }
  for (const key of [`ip:${ip}`, ...(email === null ? [] : [`email:${email.toLowerCase()}`])]) {
    failures.set(key, [...(failures.get(key) ?? []), now]);
  }
}

/** Tests only. */
export function loginLimiterSize(): number {
  return failures.size;
}

/** Tests only. */
export function resetLoginLimiter(): void {
  failures.clear();
  lastSweep = 0;
}
