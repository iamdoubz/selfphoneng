// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T1: TOTP against the RFC 6238 test vectors, the ±1 window, no reuse, recovery codes.
import { describe, expect, it } from 'vitest';
import {
  base32,
  checkTotp,
  fromBase32,
  hashRecovery,
  newRecoveryCodes,
  newTotpSecret,
  stepAt,
  totpCode,
} from './totp.ts';

// RFC 6238 appendix B, SHA1 key "12345678901234567890"; we use the last 6 digits.
const RFC_SECRET = base32(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('matches RFC 6238 SHA1 vectors', () => {
    for (const [t, code] of [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ] as const)
      expect(totpCode(RFC_SECRET, Math.floor(t / 30)), String(t)).toBe(code);
  });

  it('base32 round-trips; secrets are 32 chars', () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32(fromBase32(s))).toBe(s);
  });

  it('accepts the step before and after, not further; never the same step twice', () => {
    const now = 1_800_000_000_000;
    const s = stepAt(now);
    expect(checkTotp(RFC_SECRET, totpCode(RFC_SECRET, s), null, now)).toBe(s);
    expect(checkTotp(RFC_SECRET, totpCode(RFC_SECRET, s - 1), null, now)).toBe(s - 1);
    expect(checkTotp(RFC_SECRET, totpCode(RFC_SECRET, s + 1), null, now)).toBe(s + 1);
    expect(checkTotp(RFC_SECRET, totpCode(RFC_SECRET, s - 2), null, now)).toBeNull();
    expect(checkTotp(RFC_SECRET, totpCode(RFC_SECRET, s), s, now)).toBeNull(); // used
    expect(checkTotp(RFC_SECRET, '12345', null, now)).toBeNull();
  });

  it('recovery codes: 10, readable, hashed ignoring case and dashes', () => {
    const { codes, hashes } = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(hashRecovery(codes[0]!.toUpperCase().replace('-', ' '))).toBe(hashes[0]);
  });
});
