// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  decrypt,
  encrypt,
  generatePin,
  generateSipPassword,
  isTrivialPin,
  setSecretKey,
} from './secrets.ts';

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');

describe('secrets', () => {
  beforeEach(() => setSecretKey(keyA));

  it('round-trips, with a fresh IV each time', () => {
    for (const plain of ['', 'hunter2', 'ünïcödé 📞', 'x'.repeat(5000)]) {
      expect(decrypt(encrypt(plain))).toBe(plain);
    }
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('detects tampering in iv, tag and ciphertext', () => {
    const blob = Buffer.from(encrypt('secret value'), 'base64');
    for (const i of [0, 12, 28, blob.length - 1]) {
      const bad = Buffer.from(blob);
      bad[i] = bad[i]! ^ 1;
      expect(() => decrypt(bad.toString('base64'))).toThrow();
    }
    expect(() => decrypt('dG9vIHNob3J0')).toThrow();
  });

  it('rejects the wrong key', () => {
    const blob = encrypt('secret value');
    setSecretKey(keyB);
    expect(() => decrypt(blob)).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => setSecretKey(randomBytes(16).toString('base64'))).toThrow();
  });

  it('generates SIP passwords and non-trivial PINs', () => {
    expect(generateSipPassword()).toMatch(/^[A-Za-z0-9]{24}$/);
    for (let i = 0; i < 200; i++) {
      const pin = generatePin();
      expect(pin).toMatch(/^\d{6}$/);
      expect(isTrivialPin(pin)).toBe(false);
    }
    expect(generatePin(4)).toMatch(/^\d{4}$/);
  });

  it.each([
    ['000000', undefined, true],
    ['123456', undefined, true],
    ['654321', undefined, true],
    ['101101', '101', true],
    ['1011', '101', true],
    ['483920', '101', false],
    ['1357', undefined, false],
  ])('isTrivialPin(%s, %s) = %s', (pin, ext, expected) => {
    expect(isTrivialPin(pin, ext)).toBe(expected);
  });
});
