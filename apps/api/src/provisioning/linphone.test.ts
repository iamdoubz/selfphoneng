// SPDX-License-Identifier: AGPL-3.0-or-later
// M10-T3: the stateless Linphone token (07 §5) and the XML.
import { describe, expect, it } from 'vitest';
import { linphoneToken, linphoneXml, verifyLinphoneToken } from './linphone.ts';

const SECRET = Buffer.alloc(32, 7).toString('base64');
const OTHER = Buffer.alloc(32, 8).toString('base64');
const ID = '00000000-0000-4000-8000-000000000101';

describe('linphone token', () => {
  it('round-trips for 24 h, then expires', () => {
    const now = Date.UTC(2026, 9, 19, 12);
    const { token, expiresAt } = linphoneToken(SECRET, ID, now);
    expect(expiresAt).toBe('2026-10-20T12:00:00.000Z');
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyLinphoneToken(SECRET, token, now + 23 * 3600_000)).toBe(ID);
    expect(verifyLinphoneToken(SECRET, token, now + 24 * 3600_000 + 1000)).toBeNull();
  });

  it('refuses another secret, a changed id or expiry, and junk', () => {
    const now = Date.now();
    const { token } = linphoneToken(SECRET, ID, now);
    expect(verifyLinphoneToken(OTHER, token, now)).toBeNull();
    const [id, exp, mac] = Buffer.from(token, 'base64url').toString().split('.');
    const forge = (s: string) => Buffer.from(s).toString('base64url');
    expect(
      verifyLinphoneToken(SECRET, forge(`${ID.replace('101', '102')}.${exp}.${mac}`), now),
    ).toBeNull();
    expect(
      verifyLinphoneToken(SECRET, forge(`${id}.${Number(exp) + 3600}.${mac}`), now),
    ).toBeNull();
    expect(verifyLinphoneToken(SECRET, 'nope', now)).toBeNull();
    // Another spelling of the same bytes: the token is 112 bytes, so its last base64 character
    // holds 4 unused bits; flipping the lowest one decodes to the very same token.
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const other = token.slice(0, -1) + B64[B64.indexOf(token.at(-1)!) ^ 1];
    expect(Buffer.from(other, 'base64url').equals(Buffer.from(token, 'base64url'))).toBe(true);
    expect(verifyLinphoneToken(SECRET, other, now)).toBeNull();
    expect(verifyLinphoneToken(SECRET, forge('a.b'), now)).toBeNull();
  });
});

describe('linphone XML', () => {
  it('proxy and auth sections, values escaped', () => {
    const x = linphoneXml({
      host: 'pbx.example.com',
      sipPort: 5060,
      transport: 'udp',
      number: '101',
      name: 'Dan "D" <Doe>',
      sipPassword: 'Ab3dEf9hIj2kLm4nOp6qRs8t',
    });
    expect(x).toContain(
      '<entry name="reg_proxy">&lt;sip:pbx.example.com:5060;transport=udp&gt;</entry>',
    );
    expect(x).toContain(
      `<entry name="reg_identity">"Dan 'D' &lt;Doe&gt;" &lt;sip:101@pbx.example.com&gt;</entry>`,
    );
    expect(x).toContain('<entry name="username">101</entry>');
    expect(x).toContain('<entry name="passwd">Ab3dEf9hIj2kLm4nOp6qRs8t</entry>');
  });
});
