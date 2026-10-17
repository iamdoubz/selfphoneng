// SPDX-License-Identifier: AGPL-3.0-or-later
// The only place that normalizes phone numbers (spec 00 §8).

const RESERVED = new Set(['211', '311', '411', '511', '611', '711', '811', '911', '933']);

export function normalizeNumber(input: string, defaultCountry = '1'): string {
  const n = input.replace(/[\s\-.()]/g, '');
  if (n.startsWith('+')) {
    const rest = n.slice(1);
    if (!/^\d+$/.test(rest)) throw new Error(`Invalid phone number: ${input}`);
    if (defaultCountry === '1' && rest.startsWith('1')) {
      // TODO(spec): 00 §8 only defines +1 followed by 10 digits; other lengths are rejected.
      if (rest.length !== 11) throw new Error(`Invalid phone number: ${input}`);
      return rest;
    }
    return `011${rest}`;
  }
  if (/^[2-9]\d{9}$/.test(n)) return defaultCountry + n;
  if (/^[0-9*#]+$/.test(n)) return n;
  throw new Error(`Invalid phone number: ${input}`);
}

export function formatNumber(n: string): string {
  const m = /^1(\d{3})(\d{3})(\d{4})$/.exec(n);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n;
}

/** N11 service codes, 933, and anything starting with 0 or 1 followed by more than 2 digits. */
export function isReservedNumber(n: string): boolean {
  return RESERVED.has(n) || /^[01]\d{3,}$/.test(n);
}
