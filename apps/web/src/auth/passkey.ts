// SPDX-License-Identifier: AGPL-3.0-or-later
// Passkeys (15): the browser's part. Binary values go to the api as base64url.
import type { PasskeyCreateOptions, PasskeyLoginOptions } from '@selfphoneng/shared';

const b64u = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const bytes = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export const passkeysSupported = () =>
  typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';

export type NewPasskey = {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  publicKey: string;
  alg: number;
};
export type PasskeyAssertion = {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
};

/** The browser's own errors, in plain words. */
function explain(e: unknown): Error {
  const name = (e as { name?: string }).name;
  if (name === 'NotAllowedError') return new Error('Cancelled, or it took too long. Try again.');
  if (name === 'InvalidStateError') return new Error('This device already has a passkey for you.');
  if (name === 'SecurityError')
    return new Error('Passkeys only work on the phone system’s own address.');
  return e instanceof Error ? e : new Error('The passkey didn’t work.');
}

/** Asks the device to make a passkey (it checks the person: PIN, fingerprint or face). */
export async function createPasskey(o: PasskeyCreateOptions): Promise<NewPasskey> {
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: bytes(o.challenge),
        rp: { id: o.rpId, name: o.rpName },
        user: {
          id: new TextEncoder().encode(o.user.id),
          name: o.user.name,
          displayName: o.user.displayName,
        },
        pubKeyCredParams: o.algs.map((alg) => ({ type: 'public-key' as const, alg })),
        // Stored on the device, so signing in needs no email typed; and it checks the person.
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        attestation: 'none',
        excludeCredentials: o.exclude.map((id) => ({ type: 'public-key' as const, id: bytes(id) })),
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw explain(e);
  }
  const r = cred?.response as AuthenticatorAttestationResponse | undefined;
  const publicKey = r?.getPublicKey?.();
  if (!cred || !r || !publicKey)
    throw new Error('This browser can’t make a passkey here. Try a newer one.');
  return {
    id: b64u(cred.rawId),
    clientDataJSON: b64u(r.clientDataJSON),
    authenticatorData: b64u(r.getAuthenticatorData()),
    publicKey: b64u(publicKey),
    alg: r.getPublicKeyAlgorithm(),
  };
}

/** Asks the device for a passkey it holds for this site. */
export async function getPasskey(o: PasskeyLoginOptions): Promise<PasskeyAssertion> {
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: { challenge: bytes(o.challenge), rpId: o.rpId, userVerification: 'required' },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw explain(e);
  }
  if (!cred) throw new Error('No passkey was chosen.');
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: b64u(cred.rawId),
    clientDataJSON: b64u(r.clientDataJSON),
    authenticatorData: b64u(r.authenticatorData),
    signature: b64u(r.signature),
  };
}
