// SPDX-License-Identifier: AGPL-3.0-or-later
// Paired phones (13 §2): a one-time pairing code from the web, traded by the app for a device token
// `Authorization: Bearer spm_<40 base62>`, stored as sha256, acting as the phone's user.
import { randomInt } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { mobileDevices, users } from '../db/schema.ts';
import { generateToken, hashToken } from './tokens.ts';

export const DEVICE_TOKEN_RE = /^spm_[A-Za-z0-9]{40}$/;
/** No 0/O/1/I: people type it from a screen. */
export const PAIR_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIR_CODE_TTL_MS = 10 * 60_000;

export const generateDeviceToken = () => `spm_${generateToken().slice(3)}`;

export function generatePairCode(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += PAIR_CODE_CHARS[randomInt(PAIR_CODE_CHARS.length)];
  return s;
}

/** The device's (active) user, or null for an unknown, removed or malformed token. */
export async function getDeviceUser(db: Db, token: string) {
  if (!DEVICE_TOKEN_RE.test(token)) return null;
  const [row] = await db
    .select({ id: mobileDevices.id, user: users })
    .from(mobileDevices)
    .innerJoin(users, eq(users.id, mobileDevices.userId))
    .where(and(eq(mobileDevices.tokenHash, hashToken(token)), eq(users.isActive, true)));
  if (!row) return null;
  await db
    .update(mobileDevices)
    .set({ lastUsedAt: new Date() })
    .where(eq(mobileDevices.id, row.id));
  return { user: row.user, deviceId: row.id };
}

/**
 * Trades a pairing code for a device token, once. Null for a code that's unknown, used, expired,
 * or whose user was disabled since.
 */
export async function pairDevice(
  db: Db,
  code: string,
  device: { name: string; platform: 'android' | 'ios' },
) {
  const [row] = await db
    .select({ id: mobileDevices.id, user: users })
    .from(mobileDevices)
    .innerJoin(users, eq(users.id, mobileDevices.userId))
    .where(
      and(
        eq(mobileDevices.pairCodeHash, hashToken(code)),
        gt(mobileDevices.pairExpiresAt, new Date()),
        eq(users.isActive, true),
      ),
    );
  if (!row) return null;
  const token = generateDeviceToken();
  // The code is cleared in the same statement: two apps racing with one code can't both win.
  const [won] = await db
    .update(mobileDevices)
    .set({
      ...device,
      tokenPrefix: token.slice(0, 8),
      tokenHash: hashToken(token),
      pairCodeHash: null,
      pairExpiresAt: null,
    })
    .where(and(eq(mobileDevices.id, row.id), isNull(mobileDevices.tokenHash)))
    .returning({ id: mobileDevices.id });
  return won ? { token, deviceId: won.id, user: row.user } : null;
}
