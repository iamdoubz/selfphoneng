// SPDX-License-Identifier: AGPL-3.0-or-later
// A software passkey for tests (15): makes and signs what a browser would send.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

const site = { origin: 'https://pbx.test', rpId: 'pbx.test' };
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

/** A software authenticator: one credential, any of the three algorithms. */
export function fakeAuthenticator(alg: -7 | -8 | -257 = -7, rpId = site.rpId) {
  const { publicKey, privateKey } =
    alg === -7
      ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      : alg === -8
        ? generateKeyPairSync('ed25519')
        : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const id = sha256(publicKey.export({ format: 'der', type: 'spki' })).subarray(0, 20);
  let count = 0;
  const authData = (flags: number, withCred: boolean, counter: number) => {
    const head = Buffer.alloc(37);
    sha256(rpId).copy(head);
    head[32] = flags;
    head.writeUInt32BE(counter, 33);
    if (!withCred) return head;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(id.length);
    return Buffer.concat([head, Buffer.alloc(16), len, id, Buffer.from('cose-key-not-read')]);
  };
  const clientData = (type: string, challenge: string, origin: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id,
    create(challenge: string, o: { origin?: string; flags?: number } = {}) {
      return {
        id,
        clientDataJSON: clientData('webauthn.create', challenge, o.origin ?? site.origin),
        authenticatorData: authData(o.flags ?? 0x45, true, 0),
        publicKey: publicKey.export({ format: 'der', type: 'spki' }),
        alg,
      };
    },
    get(challenge: string, o: { origin?: string; flags?: number; counter?: number } = {}) {
      const clientDataJSON = clientData('webauthn.get', challenge, o.origin ?? site.origin);
      const authenticatorData = authData(o.flags ?? 0x05, false, o.counter ?? ++count);
      const signed = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
      return {
        clientDataJSON,
        authenticatorData,
        signature: sign(alg === -8 ? null : 'sha256', signed, privateKey),
      };
    },
  };
}
