// SPDX-License-Identifier: AGPL-3.0-or-later
// 15: the WebAuthn checks, against an authenticator made here with node:crypto.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  newChallenge,
  PasskeyError,
  resetPasskeyChallenges,
  verifyAssertion,
  verifyRegistration,
} from './passkeys.ts';
import { fakeAuthenticator } from '../../test/fake-passkey.ts';

const site = { origin: 'https://pbx.test', rpId: 'pbx.test' };

describe('passkeys', () => {
  beforeEach(resetPasskeyChallenges);

  it.each([-7, -8, -257] as const)('registers and signs in (alg %i)', (alg) => {
    const a = fakeAuthenticator(alg);
    const stored = verifyRegistration(a.create(newChallenge('u1')), site, 'u1');
    expect(stored.credentialId).toBe(a.id.toString('base64url'));
    expect(stored.alg).toBe(alg);
    const n = verifyAssertion(a.get(newChallenge(null)), stored, site);
    expect(n).toBe(1);
    expect(verifyAssertion(a.get(newChallenge(null)), { ...stored, signCount: n }, site)).toBe(2);
  });

  const registered = () => {
    const a = fakeAuthenticator();
    return { a, stored: verifyRegistration(a.create(newChallenge('u1')), site, 'u1') };
  };

  it('a challenge works once, in time, and only for whom it was made', () => {
    const { a, stored } = registered();
    const c = newChallenge(null);
    const r = a.get(c);
    verifyAssertion(r, stored, site);
    expect(() => verifyAssertion(r, stored, site)).toThrow(PasskeyError); // replayed
    expect(() => verifyAssertion(a.get('made-up'), stored, site)).toThrow(/challenge/);
    const old = newChallenge(null, Date.now() - 6 * 60_000);
    expect(() => verifyAssertion(a.get(old), stored, site)).toThrow(/challenge/);
    // A sign-in challenge can't add a passkey, nor one user's challenge another's.
    const b = fakeAuthenticator();
    expect(() => verifyRegistration(b.create(newChallenge(null)), site, 'u1')).toThrow(/challenge/);
    expect(() => verifyRegistration(b.create(newChallenge('u2')), site, 'u1')).toThrow(/challenge/);
    expect(() => verifyAssertion(a.get(newChallenge('u1')), stored, site)).toThrow(/challenge/);
  });

  it('refuses another origin, another site, and no user verification', () => {
    const { a, stored } = registered();
    expect(() =>
      verifyAssertion(a.get(newChallenge(null), { origin: 'https://evil.test' }), stored, site),
    ).toThrow(/origin/);
    const other = fakeAuthenticator(-7, 'evil.test');
    expect(() => verifyRegistration(other.create(newChallenge('u1')), site, 'u1')).toThrow(/site/);
    expect(() => verifyAssertion(a.get(newChallenge(null), { flags: 0x01 }), stored, site)).toThrow(
      /verified/,
    );
    expect(() =>
      verifyRegistration(a.create(newChallenge('u1'), { flags: 0x41 }), site, 'u1'),
    ).toThrow(/verified/);
  });

  it('refuses a wrong signature, a wrong key kind, and a counter that went back', () => {
    const { a, stored } = registered();
    const r = a.get(newChallenge(null));
    r.signature[r.signature.length - 1]! ^= 1;
    expect(() => verifyAssertion(r, stored, site)).toThrow(/signature/);
    const b = fakeAuthenticator();
    expect(() => verifyAssertion(b.get(newChallenge(null)), stored, site)).toThrow(/signature/);
    expect(() =>
      verifyAssertion(a.get(newChallenge(null)), { ...stored, alg: -257 }, site),
    ).toThrow(/algorithm/);
    expect(() =>
      verifyAssertion(a.get(newChallenge(null), { counter: 5 }), { ...stored, signCount: 5 }, site),
    ).toThrow(/counter/);
    // Synced passkeys: 0 stays 0.
    expect(verifyAssertion(a.get(newChallenge(null), { counter: 0 }), stored, site)).toBe(0);
  });

  it('refuses a credential id that is not the one in the authenticator data', () => {
    const a = fakeAuthenticator();
    const r = a.create(newChallenge('u1'));
    expect(() => verifyRegistration({ ...r, id: Buffer.from('other') }, site, 'u1')).toThrow(
      /credential id/,
    );
  });
});
