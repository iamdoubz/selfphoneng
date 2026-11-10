// SPDX-License-Identifier: AGPL-3.0-or-later
// Passkeys (15): WebAuthn checks with node:crypto only. No attestation ('none'), so there's no
// CBOR to read: the browser hands over the public key (SPKI) and the authenticator data.
import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';

const TTL_MS = 5 * 60_000;
const MAX_PENDING = 10_000;
const UP_UV = 0x05; // user present + user verified
const AT = 0x40; // attested credential data follows

/** COSE algorithms we ask for: ES256, EdDSA, RS256. */
export const PASSKEY_ALGS = [-7, -8, -257];

// ponytail: pending challenges live in this process, like the login limiter. A restart drops
// them (the person clicks again); move to a table if the api ever runs as more than one process.
const pending = new Map<string, { exp: number; userId: string | null }>();

/** A one-time challenge: for adding a passkey to `userId`, or (null) for signing in. */
export function newChallenge(userId: string | null, now = Date.now()): string {
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
  // Anyone can ask for a sign-in challenge: the oldest go first when there are too many.
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
  const c = randomBytes(32).toString('base64url');
  pending.set(c, { exp: now + TTL_MS, userId });
  return c;
}

/** True once per challenge, and only for whom it was made. */
function takeChallenge(c: string, userId: string | null, now: number): boolean {
  const v = pending.get(c);
  pending.delete(c);
  return !!v && v.exp >= now && v.userId === userId;
}

export const resetPasskeyChallenges = () => pending.clear();

export class PasskeyError extends Error {}
const fail = (why: string): never => {
  throw new PasskeyError(why);
};

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

export type Site = { origin: string; rpId: string };

function checkClientData(
  json: Buffer,
  type: 'webauthn.create' | 'webauthn.get',
  site: Site,
  userId: string | null,
  now: number,
) {
  let c: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    c = JSON.parse(json.toString('utf8'));
  } catch {
    return fail('client data is not JSON');
  }
  if (typeof c.challenge !== 'string' || !takeChallenge(c.challenge, userId, now))
    fail('challenge unknown, used or expired');
  if (c.type !== type) fail('wrong type');
  if (c.origin !== site.origin) fail('wrong origin');
  if (c.crossOrigin === true) fail('cross-origin');
}

function parseAuthData(a: Buffer, site: Site) {
  if (a.length < 37) fail('authenticator data too short');
  if (!a.subarray(0, 32).equals(sha256(site.rpId))) fail('wrong site');
  const flags = a[32]!;
  // The passkey is both steps (15 §1): the device must have checked the person (PIN, finger, face).
  if ((flags & UP_UV) !== UP_UV) fail('user not verified');
  return { flags, signCount: a.readUInt32BE(33), rest: a.subarray(37) };
}

/** The key, only if it is the kind `alg` says: no ES256 signature checked with an RSA key. */
function loadKey(spki: Buffer, alg: number): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    return fail('bad public key');
  }
  const t = key.asymmetricKeyType;
  const d = key.asymmetricKeyDetails;
  const ok =
    alg === -7
      ? t === 'ec' && d?.namedCurve === 'prime256v1'
      : alg === -257
        ? t === 'rsa' && (d?.modulusLength ?? 0) >= 2048
        : alg === -8 && t === 'ed25519';
  if (!ok) fail('key does not match its algorithm');
  return key;
}

export type NewPasskey = {
  id: Buffer;
  clientDataJSON: Buffer;
  authenticatorData: Buffer;
  publicKey: Buffer;
  alg: number;
};

/** Checks a new passkey made for `userId`; returns what to store. Throws PasskeyError. */
export function verifyRegistration(r: NewPasskey, site: Site, userId: string, now = Date.now()) {
  checkClientData(r.clientDataJSON, 'webauthn.create', site, userId, now);
  const a = parseAuthData(r.authenticatorData, site);
  if (!(a.flags & AT) || a.rest.length < 18) fail('no credential in authenticator data');
  const len = a.rest.readUInt16BE(16);
  const credId = a.rest.subarray(18, 18 + len);
  if (len < 1 || len > 1023 || credId.length !== len || !credId.equals(r.id))
    fail('credential id mismatch');
  loadKey(r.publicKey, r.alg);
  return {
    credentialId: credId.toString('base64url'),
    publicKey: r.publicKey.toString('base64'),
    alg: r.alg,
    signCount: a.signCount,
  };
}

export type Assertion = { clientDataJSON: Buffer; authenticatorData: Buffer; signature: Buffer };

/** Checks a sign-in with a stored passkey; returns the new counter. Throws PasskeyError. */
export function verifyAssertion(
  r: Assertion,
  stored: { publicKey: string; alg: number; signCount: number },
  site: Site,
  now = Date.now(),
): number {
  checkClientData(r.clientDataJSON, 'webauthn.get', site, null, now);
  const a = parseAuthData(r.authenticatorData, site);
  const key = loadKey(Buffer.from(stored.publicKey, 'base64'), stored.alg);
  const signed = Buffer.concat([r.authenticatorData, sha256(r.clientDataJSON)]);
  let ok = false;
  try {
    ok = verify(stored.alg === -8 ? null : 'sha256', signed, key, r.signature);
  } catch {
    // a malformed signature
  }
  if (!ok) fail('bad signature');
  // Synced passkeys always say 0. One that counts must go up, or it was copied.
  if ((a.signCount || stored.signCount) && a.signCount <= stored.signCount)
    fail('counter went back');
  return a.signCount;
}
