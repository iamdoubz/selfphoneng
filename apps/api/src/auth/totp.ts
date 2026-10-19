// SPDX-License-Identifier: AGPL-3.0-or-later
// TOTP for admins (08 §2.4): RFC 6238, HMAC-SHA1, 30 s steps, 6 digits, ±1 step, and 10
// single-use recovery codes stored as sha256. node:crypto only.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STEP_S = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of s.toUpperCase().replace(/[\s=]/g, '')) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new secret (160 bits), base32 as authenticator apps take it. */
export const newTotpSecret = () => base32(randomBytes(20));

/** The 6-digit code for a 30 s step (RFC 4226 dynamic truncation). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const o = h[19]! & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

export const stepAt = (now = Date.now()) => Math.floor(now / 1000 / STEP_S);

/**
 * The step `code` is valid for (now ±1), or null. Steps up to `lastStep` were used already:
 * a code can't sign in twice.
 */
export function checkTotp(
  secret: string,
  code: string,
  lastStep: number | null,
  now = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const s = stepAt(now);
  for (const step of [s - 1, s, s + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export const otpauthUrl = (secret: string, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

const RC = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i
/** 10 recovery codes like "k7m3q-x9tpw", and what to store. */
export function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: 10 }, () => {
    const b = randomBytes(10);
    const s = [...b].map((x) => RC[x % RC.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { codes, hashes: codes.map(hashRecovery) };
}

/** Case and dashes don't matter when typing a recovery code. */
export const hashRecovery = (code: string) =>
  createHash('sha256')
    .update(code.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .digest('hex');
