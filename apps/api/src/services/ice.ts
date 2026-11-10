// SPDX-License-Identifier: AGPL-3.0-or-later
// ICE servers for the browser softphone and the mobile app (04 §12): STUN, and a TURN relay with
// either one username and password for everyone, or a shared key that makes a short-lived
// credential per person (coturn's use-auth-secret, the "TURN REST API").
import { createHmac } from 'node:crypto';
import type { WebRtcCreds } from '@selfphoneng/shared';
import { decrypt } from '../crypto/secrets.ts';
import type { Db } from '../db/client.ts';
import { getSetting } from './settings.ts';

/**
 * username = "<unix time it ends>:<who>", credential = base64(HMAC-SHA1(key, username)). The TURN
 * server, holding the same key, checks the signature and the time; nothing is stored there.
 */
export function timedTurnCredential(key: string, who: string, ttlSeconds: number, now: number) {
  const username = `${Math.floor(now / 1000) + ttlSeconds}:${who}`;
  return { username, credential: createHmac('sha1', key).update(username).digest('base64') };
}

/** What `who` (an extension number) gets, and when to ask again (null: it never runs out). */
export async function iceServersFor(
  db: Db,
  who: string,
  now = Date.now(),
): Promise<Pick<WebRtcCreds, 'iceServers' | 'iceRefreshSeconds'>> {
  const stun = await getSetting(db, 'network.stunServer');
  const turn = await getSetting(db, 'network.turn');
  const iceServers: WebRtcCreds['iceServers'] = stun ? [{ urls: `stun:${stun}` }] : [];
  if (!turn) return { iceServers, iceRefreshSeconds: null };
  const secret = decrypt(turn.credentialEnc);
  if (turn.auth === 'password') {
    iceServers.push({ urls: turn.urls, username: turn.username, credential: secret });
    return { iceServers, iceRefreshSeconds: null };
  }
  iceServers.push({ urls: turn.urls, ...timedTurnCredential(secret, who, turn.ttlSeconds, now) });
  // Asked again at half time, so a call that starts late still has a good while left.
  return { iceServers, iceRefreshSeconds: Math.floor(turn.ttlSeconds / 2) };
}
