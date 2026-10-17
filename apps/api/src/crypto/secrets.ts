// SPDX-License-Identifier: AGPL-3.0-or-later
// The only place that encrypts and decrypts `_enc` columns (spec 02, 04 §3).
// Format: base64(iv[12] | tag[16] | ciphertext), AES-256-GCM, key = base64decode(APP_SECRET).
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';

let key: Buffer | undefined;

/** Called once at startup with APP_SECRET (config.ts has already checked it is 32 bytes). */
export function setSecretKey(appSecretBase64: string): void {
  const k = Buffer.from(appSecretBase64, 'base64');
  if (k.length !== 32) throw new Error('APP_SECRET must decode to 32 bytes');
  key = k;
}

function getKey(): Buffer {
  if (!key) throw new Error('secrets: setSecretKey() was not called');
  return key;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < 28) throw new Error('secrets: ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomAlnum(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ALNUM[randomInt(ALNUM.length)];
  return s;
}

export function generateSipPassword(): string {
  return randomAlnum(24);
}

/** Trivial PINs are easy to guess from *98 (08 §1): one repeated digit, or a run like 123456/654321. */
export function isTrivialPin(pin: string, extension?: string): boolean {
  if (/^(\d)\1*$/.test(pin)) return true;
  if ('01234567890'.includes(pin) || '09876543210'.includes(pin)) return true;
  if (
    extension &&
    pin === extension.repeat(Math.ceil(pin.length / extension.length)).slice(0, pin.length)
  )
    return true;
  return false;
}

export function generatePin(len = 6): string {
  for (;;) {
    let pin = '';
    for (let i = 0; i < len; i++) pin += randomInt(10);
    if (!isTrivialPin(pin)) return pin;
  }
}
