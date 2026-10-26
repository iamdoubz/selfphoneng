// SPDX-License-Identifier: AGPL-3.0-or-later
// 12 S5: the Active Directory preset against a real Samba AD DC: sign-in by sAMAccountName, UPN
// and mail, admin through a nested group (LDAP_MATCHING_RULE_IN_CHAIN), the disabled bit,
// objectGUID as hex, and directoryCheck disabling a deleted user. Needs AD_LIVE_URL (ldaps://…,
// with NODE_EXTRA_CA_CERTS naming its CA) and AD_LIVE_ADMIN_PASS (the Administrator's).
// Passed against Samba 4 (diegogslomp/samba-ad-dc), its smb.conf given a throwaway certificate
// for 127.0.0.1 (`tls keyfile`, `tls certfile`, `tls cafile`):
//   docker run -d --privileged -p 127.0.0.1:11636:636 -e REALM=EXAMPLE.COM -e DOMAIN=EXAMPLE \
//     -e ADMIN_PASS=… -e DNS_FORWARDER=1.1.1.1 -e BIND_NETWORK_INTERFACES=false \
//     diegogslomp/samba-ad-dc
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Attribute, Client } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LDAP_PRESETS } from '@selfphoneng/shared';
import { resetLoginLimiter } from '../src/auth/login-limiter.ts';
import { encrypt } from '../src/crypto/secrets.ts';
import { userIdentities, users } from '../src/db/schema.ts';
import { setSetting } from '../src/services/settings.ts';
import { checkDirectory } from '../src/sso/directory.ts';
import { hasTestDb } from './db.ts';
import { H, createTestApp } from './app.ts';

const URL_ = process.env.AD_LIVE_URL;
const ADMIN_PASS = process.env.AD_LIVE_ADMIN_PASS ?? '';
const DC = 'DC=example,DC=com';
const BASE = `CN=Users,${DC}`;
const ADMIN_DN = `CN=Administrator,${BASE}`;

describe.skipIf(!hasTestDb || !URL_)('Active Directory with a real Samba AD DC (12 S5)', () => {
  const tag = randomBytes(3).toString('hex');
  const [ann, bob, dan, cat] = ['ann', 'bob', 'dan', 'cat'].map((n) => `${n}${tag}`) as [
    string,
    string,
    string,
    string,
  ];
  const team = `CN=team-${tag},${BASE}`;
  const admins = `CN=pbx-admins-${tag},${BASE}`;
  const dn = (sam: string) => `CN=${sam},${BASE}`;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let ad: Client;

  const login = (who: string, password: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { login: who, password },
    });
  const row = async (sam: string) =>
    (
      await t.db
        .select()
        .from(users)
        .where(eq(users.email, `${sam}@example.com`))
    )[0]!;

  beforeAll(async () => {
    ad = new Client({ url: URL_! });
    await ad.bind(ADMIN_DN, ADMIN_PASS);
    // userAccountControl 512: a normal account; 514: the same, disabled.
    for (const [sam, uac] of [
      [ann, '512'],
      [bob, '512'],
      [dan, '514'],
      [cat, '512'],
    ] as const)
      await ad.add(dn(sam), [
        ...Object.entries({
          objectClass: ['top', 'person', 'organizationalPerson', 'user'],
          sAMAccountName: [sam],
          userPrincipalName: [`${sam}@example.com`],
          mail: [`${sam}@example.com`],
          displayName: [sam],
          userAccountControl: [uac],
        }).map(([type, values]) => new Attribute({ type, values })),
        // AD's password: the quoted string in UTF-16LE, only over an encrypted connection.
        new Attribute({
          type: 'unicodePwd',
          values: [Buffer.from(`"${sam}-Directory-Pw1"`, 'utf16le')],
        }),
      ]);
    // ann is in team, team is in pbx-admins: only the nested-group rule finds her admin.
    await ad.add(team, {
      objectClass: ['top', 'group'],
      sAMAccountName: `team-${tag}`,
      member: dn(ann),
    });
    await ad.add(admins, {
      objectClass: ['top', 'group'],
      sAMAccountName: `pbx-admins-${tag}`,
      member: team,
    });

    t = await createTestApp();
    for (const sam of [ann, bob, dan, cat])
      await t.addUser(`${sam}@example.com`, 'local-password-1');
    await setSetting(t.db, 'auth.ldap', {
      enabled: true,
      preset: 'ad',
      url: URL_!,
      startTls: false,
      bindDn: ADMIN_DN,
      bindPasswordEnc: encrypt(ADMIN_PASS),
      baseDn: BASE,
      userFilter: LDAP_PRESETS.ad.userFilter,
      idAttribute: LDAP_PRESETS.ad.idAttribute,
      emailAttribute: 'mail',
      nameAttribute: 'displayName',
      adminFilter: `(memberOf:1.2.840.113556.1.4.1941:=${admins})`,
    });
  }, 60_000);

  afterAll(async () => {
    await t?.close();
    for (const d of [admins, team, ...[ann, bob, dan, cat].map(dn)])
      await ad?.del(d).catch(() => {});
    await ad?.unbind();
  });

  it('signs in by sAMAccountName; a nested group makes an admin; objectGUID is stored as hex', async () => {
    resetLoginLimiter();
    const r = await login(ann, `${ann}-Directory-Pw1`);
    expect(r.statusCode).toBe(200);
    expect(r.json().user).toMatchObject({ role: 'admin', signIn: { ldap: true } });
    const [ident] = await t.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, (await row(ann)).id));
    expect(ident!.subject).toMatch(/^[0-9a-f]{32}$/);
  });

  it('signs in by UPN and by mail; outside the group is a user', async () => {
    resetLoginLimiter();
    expect((await login(`${bob}@example.com`, `${bob}-Directory-Pw1`)).json().user.role).toBe(
      'user',
    );
    resetLoginLimiter();
    expect((await login(`${ann}@example.com`, `${ann}-Directory-Pw1`)).statusCode).toBe(200);
  });

  it('a disabled account (userAccountControl bit 2) is refused', async () => {
    resetLoginLimiter();
    expect((await login(dan, `${dan}-Directory-Pw1`)).statusCode).toBe(401);
  });

  it('directoryCheck disables a deleted user and keeps the rest', async () => {
    resetLoginLimiter();
    expect((await login(cat, `${cat}-Directory-Pw1`)).statusCode).toBe(200);
    await ad.del(dn(cat));
    await checkDirectory({ db: t.db, log: { info: () => {}, warn: () => {} } });
    expect((await row(cat)).isActive).toBe(false);
    expect(await row(ann)).toMatchObject({ isActive: true, role: 'admin' });
    expect((await row(bob)).isActive).toBe(true);
  });
});
