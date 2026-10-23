// SPDX-License-Identifier: AGPL-3.0-or-later
// Caller names on desk phones while they ring (11 §6 C4): before ringing a user's phones, the
// dialplan asks GET /api/internal/caller-name (func_curl, 2 s at most) for that user's name for
// the caller, and the phones show it.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The dialplan's key for the route, derived from APP_SECRET (stable across restarts). */
export const callerNameToken = (appSecret: string) =>
  createHmac('sha256', appSecret).update('selfphoneng caller-name').digest('hex');

export const sameToken = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * What a phone can show and the dialplan can carry: letters, digits, spaces and . ' & @ -, at
 * most 40 characters. Nothing that Dial's options (, ^ ( ) |) or a SIP header (" < > \ ;) could
 * read as syntax.
 */
export const phoneSafeName = (name: string) =>
  name
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N} .'&@-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
