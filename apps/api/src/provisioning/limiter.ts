// SPDX-License-Identifier: AGPL-3.0-or-later
// /prov limits (07 §2): 20 requests per 10 min per IP; 10 failures (unknown MAC, wrong password)
// block the IP for an hour. Phones on the local nets skip the request limit: an office's phones
// all rebooting at once would pass 20 in a minute. Failures count for everyone.
// ponytail: in-process memory like the login limiter; resets on restart (v1 has one api process).
const MIN = 60_000;
const REQUESTS = { max: 20, windowMs: 10 * MIN };
const FAILURES = { max: 10, windowMs: 60 * MIN, blockMs: 60 * MIN };

const requests = new Map<string, number[]>();
const failures = new Map<string, number[]>();
const blockedUntil = new Map<string, number>();

const recent = (m: Map<string, number[]>, ip: string, windowMs: number, now: number) => {
  const list = (m.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (list.length) m.set(ip, list);
  else m.delete(ip);
  return list;
};

/** Counts this request; false when the IP is blocked or over its limit. */
export function allowProvRequest(ip: string, local: boolean, now = Date.now()): boolean {
  if ((blockedUntil.get(ip) ?? 0) > now) return false;
  blockedUntil.delete(ip);
  if (local) return true;
  const list = recent(requests, ip, REQUESTS.windowMs, now);
  if (list.length >= REQUESTS.max) return false;
  requests.set(ip, [...list, now]);
  return true;
}

export function recordProvFailure(ip: string, now = Date.now()): void {
  const list = [...recent(failures, ip, FAILURES.windowMs, now), now];
  failures.set(ip, list);
  if (list.length >= FAILURES.max) blockedUntil.set(ip, now + FAILURES.blockMs);
}

/** Tests only. */
export function resetProvLimiter(): void {
  requests.clear();
  failures.clear();
  blockedUntil.clear();
}
