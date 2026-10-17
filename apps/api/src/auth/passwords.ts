// SPDX-License-Identifier: AGPL-3.0-or-later
// argon2id with library defaults; minimum 10 chars; reject common passwords (04 §2.1).
import { readFileSync } from 'node:fs';
import { hash, verify } from '@node-rs/argon2';
import { PASSWORD_MIN } from '@selfphoneng/shared';
import { badRequest } from '../errors.ts';

const COMMON = new Set(
  readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.toLowerCase()),
);

export const hashPassword = (plain: string) => hash(plain);

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

// A real hash to verify against when the email is unknown, so timing doesn't reveal which emails exist.
const DUMMY = hash('dummy-password-for-timing');
export async function burnVerify(plain: string): Promise<void> {
  await verifyPassword(await DUMMY, plain);
}

export function assertPasswordPolicy(plain: string): void {
  if (plain.length < PASSWORD_MIN)
    throw badRequest(`Password must be at least ${PASSWORD_MIN} characters`);
  if (COMMON.has(plain.toLowerCase())) throw badRequest('This password is too common');
}
