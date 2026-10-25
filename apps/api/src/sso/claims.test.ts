// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { claimValues, decide, verifiedEmail } from './claims.ts';

describe('OpenID claims (12 §3.4)', () => {
  const keycloak = {
    groups: ['/pbx-admins', 'pbx-users'],
    realm_access: { roles: ['offline_access', 'pbx-admin'] },
    resource_access: { selfphoneng: { roles: ['operator'] } },
    'urn:zitadel:iam:org:project:roles': { 'pbx-admin': { '123': 'example.com' } },
    hd: 'example.com',
  };

  it('reads dotted paths, whole keys first', () => {
    expect(claimValues(keycloak, 'groups')).toEqual(['/pbx-admins', 'pbx-users']);
    expect(claimValues(keycloak, 'realm_access.roles')).toContain('pbx-admin');
    expect(claimValues(keycloak, 'resource_access.selfphoneng.roles')).toEqual(['operator']);
    expect(claimValues(keycloak, 'urn:zitadel:iam:org:project:roles')).toEqual(['pbx-admin']);
    expect(claimValues(keycloak, 'hd')).toEqual(['example.com']);
    expect(claimValues(keycloak, 'missing.path')).toEqual([]);
    expect(claimValues({ 'a.b': ['x'], a: { b: ['y'] } }, 'a.b')).toEqual(['x']);
  });

  it('decides allowed and role, comparing names exactly', () => {
    const rules = { groupsClaim: 'groups', adminGroups: [], allowedGroups: [] };
    expect(decide(rules, keycloak)).toMatchObject({ allowed: true, admin: null });
    expect(decide({ ...rules, adminGroups: ['pbx-admins'] }, keycloak).admin).toBe(false);
    expect(decide({ ...rules, adminGroups: ['/pbx-admins'] }, keycloak).admin).toBe(true);
    expect(decide({ ...rules, allowedGroups: ['sales'] }, keycloak).allowed).toBe(false);
    expect(decide({ ...rules, allowedGroups: ['sales', 'pbx-users'] }, keycloak).allowed).toBe(
      true,
    );
  });

  it('takes an email only when verified, or trusted', () => {
    expect(verifiedEmail({ email: 'a@x.com', email_verified: true }, false)).toBe('a@x.com');
    expect(verifiedEmail({ email: 'a@x.com', email_verified: 'true' }, false)).toBeNull();
    expect(verifiedEmail({ email: 'a@x.com' }, false)).toBeNull();
    expect(verifiedEmail({ email: 'a@x.com' }, true)).toBe('a@x.com');
    expect(verifiedEmail({}, true)).toBeNull();
  });
});
