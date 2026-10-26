// SPDX-License-Identifier: AGPL-3.0-or-later
import { BerWriter } from 'ldapts';
import { describe, expect, it } from 'vitest';
import {
  anyLogin,
  assertLdap,
  byIdFilter,
  ldapAuthenticate,
  withLogin,
  type LdapSettings,
} from './ldap.ts';

describe('LDAP (12 §4)', () => {
  const f = '(&(objectClass=person)(|(uid={login})(mail={login})))';

  it('escapes the login, so it can only ever be a value (RFC 4515)', () => {
    expect(withLogin(f, 'ann')).toBe('(&(objectClass=person)(|(uid=ann)(mail=ann)))');
    expect(withLogin(f, '*)(uid=*))(|(uid=*')).toBe(
      '(&(objectClass=person)(|(uid=\\2a\\29\\28uid=\\2a\\29\\29\\28|\\28uid=\\2a)(mail=\\2a\\29\\28uid=\\2a\\29\\29\\28|\\28uid=\\2a)))',
    );
    expect(withLogin('(uid={login})', 'a\\b\u0000')).toBe('(uid=a\\5cb\\00)');
  });

  it('{login} → * keeps the other conditions, for the leaver check', () => {
    expect(anyLogin(f)).toBe('(&(objectClass=person)(|(uid=*)(mail=*)))');
  });

  it('finds a leaver by id, keeping the other conditions of the filter (§4.5)', () => {
    expect(byIdFilter({ idAttribute: 'entryUUID', userFilter: f }, 'a*b').toString()).toBe(
      '(&(entryUUID=a\\2ab)(&(objectClass=person)(|(uid=*)(mail=*))))',
    );
    // AD: objectGUID is stored as hex and searched as its bytes (§4.4).
    const guid = byIdFilter({ idAttribute: 'objectGUID', userFilter: '(cn={login})' }, '00ff2a');
    expect(guid.toString()).toBe('(&(objectGUID=\\00\\ff\\2a)(cn=*))');
    // …and goes out as those three bytes, not U+00FF in UTF-8.
    const ber = new BerWriter();
    guid.write(ber);
    expect(ber.buffer.includes(Buffer.from([0x04, 0x03, 0x00, 0xff, 0x2a]))).toBe(true);
  });

  it('never sends a password in clear text to another host', () => {
    const ok = { startTls: false, userFilter: f, adminFilter: null };
    expect(() => assertLdap({ ...ok, url: 'ldap://dc1.example.com' })).toThrow(/clear text/);
    expect(() =>
      assertLdap({ ...ok, url: 'ldap://dc1.example.com', startTls: true }),
    ).not.toThrow();
    expect(() => assertLdap({ ...ok, url: 'ldaps://dc1.example.com' })).not.toThrow();
    expect(() => assertLdap({ ...ok, url: 'ldap://127.0.0.1:3890' })).not.toThrow();
    expect(() => assertLdap({ ...ok, url: 'ldaps://x', startTls: true })).toThrow(/StartTLS/);
  });

  it('refuses filters that do not parse', () => {
    const base = { url: 'ldaps://x', startTls: false, userFilter: f, adminFilter: null };
    expect(() => assertLdap({ ...base, userFilter: '(uid={login}' })).toThrow(/User filter/);
    expect(() => assertLdap({ ...base, adminFilter: 'memberOf=x)' })).toThrow(/Admin filter/);
  });

  it('an empty password fails before anything is sent (no "unauthenticated bind")', async () => {
    // A directory that doesn't exist: any attempt to connect would throw DirectoryUnavailable.
    const s = { url: 'ldaps://192.0.2.1', startTls: false, userFilter: f } as LdapSettings;
    expect(await ldapAuthenticate(s, 'ann', '')).toBeNull();
  });
});
