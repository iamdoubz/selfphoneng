// SPDX-License-Identifier: AGPL-3.0-or-later
// 12 S4-S5 against a real lldap: sign in by uid and by email, connect by email, no user made for
// a stranger, admin by memberOf, Test, LDAPS, directoryCheck disabling a removed user. Needs
// LDAP_LIVE_URL (ldap://127.0.0.1:<port>) and LDAP_LIVE_HTTP (its web port, to make the users);
// LDAP_LIVE_LDAPS_URL to try LDAPS too, with NODE_EXTRA_CA_CERTS naming the CA of its
// certificate. Admin password: LDAP_LIVE_ADMIN_PASS.
// Passed against lldap 0.6.3:
//   docker run -d -p 127.0.0.1:13890:3890 -p 127.0.0.1:16360:6360 -p 127.0.0.1:17170:17170 \
//     -e LLDAP_JWT_SECRET=… -e LLDAP_KEY_SEED=… -e LLDAP_LDAP_USER_PASS=admin-pass-123 \
//     -e LLDAP_LDAP_BASE_DN=dc=example,dc=com [-e LLDAP_LDAPS_OPTIONS__ENABLED=true …] \
//     lldap/lldap:v0.6.3-alpine
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Client } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto/secrets.ts';
import { userIdentities, users } from '../src/db/schema.ts';
import { resetLoginLimiter } from '../src/auth/login-limiter.ts';
import { setSetting } from '../src/services/settings.ts';
import { checkDirectory } from '../src/sso/directory.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const URL_ = process.env.LDAP_LIVE_URL;
const HTTP = process.env.LDAP_LIVE_HTTP;
const LDAPS = process.env.LDAP_LIVE_LDAPS_URL;
const ADMIN_PASS = process.env.LDAP_LIVE_ADMIN_PASS ?? 'admin-pass-123';
const BASE = 'dc=example,dc=com';

/** RFC 3062 password modify request: SEQUENCE { [0] user DN, [2] new password }. */
function passwordModify(dn: string, password: string): Buffer {
  const tlv = (tag: number, v: Buffer) => Buffer.concat([Buffer.from([tag, v.length]), v]);
  return tlv(0x30, Buffer.concat([tlv(0x80, Buffer.from(dn)), tlv(0x82, Buffer.from(password))]));
}

describe.skipIf(!hasTestDb || !URL_ || !HTTP)('LDAP with a real lldap (12 S4)', () => {
  const tag = randomBytes(3).toString('hex');
  const ann = `ann${tag}`;
  const bob = `bob${tag}`;
  const cat = `cat${tag}`;
  const dee = `dee${tag}`;
  const group = `pbx-admins-${tag}`;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let jwt: string;
  let admin: string;

  const gql = async (query: string) => {
    const r = await fetch(`${HTTP}/api/graphql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const j = (await r.json()) as { data: Record<string, unknown>; errors?: unknown };
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  };
  const settings = (url = URL_!) => ({
    enabled: true,
    preset: 'lldap' as const,
    url,
    startTls: false,
    bindDn: `uid=admin,ou=people,${BASE}`,
    bindPasswordEnc: encrypt(ADMIN_PASS),
    baseDn: `ou=people,${BASE}`,
    userFilter: '(&(objectClass=person)(|(uid={login})(mail={login})))',
    idAttribute: 'entryUUID',
    emailAttribute: 'mail',
    nameAttribute: 'displayName',
    adminFilter: `(memberOf=cn=${group},ou=groups,${BASE})`,
  });
  const login = (who: string, password: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: H,
      payload: { login: who, password },
    });

  beforeAll(async () => {
    const r = await fetch(`${HTTP}/auth/simple/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASS }),
    });
    jwt = ((await r.json()) as { token: string }).token;
    for (const [id, name] of [
      [ann, 'Ann Lee'],
      [bob, 'Bob Roe'],
      [cat, 'Cat Poe'],
      [dee, 'Dee Fox'],
    ])
      await gql(
        `mutation { createUser(user: { id: "${id}", email: "${id}@example.com", displayName: "${name}" }) { id } }`,
      );
    const g = (await gql(`mutation { createGroup(name: "${group}") { id } }`)) as {
      createGroup: { id: number };
    };
    await gql(`mutation { addUserToGroup(userId: "${ann}", groupId: ${g.createGroup.id}) { ok } }`);
    const c = new Client({ url: URL_! });
    await c.bind(`uid=admin,ou=people,${BASE}`, ADMIN_PASS);
    for (const id of [ann, bob, cat, dee])
      await c.exop(
        '1.3.6.1.4.1.4203.1.11.1',
        passwordModify(`uid=${id},ou=people,${BASE}`, `${id}-directory-pw`),
      );
    await c.unbind();

    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    admin = await t.login(ADMIN.email, ADMIN.password);
    // New users with the temporary password from Users: the directory email may connect them.
    for (const who of [ann, cat]) {
      await t.addUser(`${who}@example.com`, `${who}-local-pw-12`);
      await t.db
        .update(users)
        .set({ mustChangePassword: true })
        .where(eq(users.email, `${who}@example.com`));
    }
    await t.addUser(`${dee}@example.com`, 'dee-own-password-12'); // chose her own password
    await setSetting(t.db, 'auth.ldap', settings());
  }, 60_000);

  afterAll(async () => {
    await t?.close();
    for (const id of [ann, bob, cat, dee])
      await gql(`mutation { deleteUser(userId: "${id}") { ok } }`).catch(() => {});
  });

  it('methods say the directory is on', async () => {
    expect((await t.app.inject({ url: '/api/auth/methods' })).json().ldap).toBe(true);
  });

  it('signs in by uid, connecting the user by email, and memberOf makes an admin', async () => {
    resetLoginLimiter();
    const r = await login(ann, `${ann}-directory-pw`);
    expect(r.statusCode).toBe(200);
    expect(r.json().user).toMatchObject({
      email: `${ann}@example.com`,
      role: 'admin',
      signIn: { password: true, ldap: true },
    });
    const [u] = await t.db
      .select()
      .from(users)
      .where(eq(users.email, `${ann}@example.com`));
    const ids = await t.db.select().from(userIdentities).where(eq(userIdentities.userId, u!.id));
    expect(ids).toMatchObject([{ kind: 'ldap', email: `${ann}@example.com` }]);
    expect(ids[0]!.subject).toMatch(/^[0-9a-f-]{36}$/); // entryUUID
  });

  it('signs in by email too, and the local password still works', async () => {
    resetLoginLimiter();
    expect((await login(`${ann}@example.com`, `${ann}-directory-pw`)).statusCode).toBe(200);
    expect((await login(`${ann}@example.com`, `${ann}-local-pw-12`)).statusCode).toBe(200);
  });

  it('a wrong password, an empty one, and a stranger are refused alike', async () => {
    resetLoginLimiter();
    for (const [who, pw] of [
      [ann, 'wrong-password'],
      [ann, ''],
      [bob, `${bob}-directory-pw`], // in the directory, but nobody here: no user is made
      ['*', `${ann}-directory-pw`],
    ]) {
      const r = await login(who!, pw!);
      expect([400, 401]).toContain(r.statusCode);
    }
    const [b] = await t.db
      .select()
      .from(users)
      .where(eq(users.email, `${bob}@example.com`));
    expect(b).toBeUndefined();
  });

  it('a directory that is down is a 503, and local passwords still work', async () => {
    resetLoginLimiter();
    await setSetting(t.db, 'auth.ldap', settings('ldap://127.0.0.1:1'));
    try {
      const r = await login(ann, `${ann}-directory-pw`);
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe('directory_unavailable');
      expect((await login(`${ann}@example.com`, `${ann}-local-pw-12`)).statusCode).toBe(200);
    } finally {
      await setSetting(t.db, 'auth.ldap', settings());
    }
  });

  it('Test: counts people, and a test login says who it would be', async () => {
    const { bindPasswordEnc: _, ...form } = settings();
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/settings/auth/ldap/test',
      headers: { ...H, cookie: admin },
      payload: { ...form, testLogin: ann, testPassword: `${ann}-directory-pw` },
    });
    expect(r.json()).toMatchObject({
      ok: true,
      user: { email: `${ann}@example.com`, admin: true, matches: `${ann}@example.com` },
    });
    expect(r.json().matching).toBeGreaterThanOrEqual(3);
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/settings/auth/ldap/test',
      headers: { ...H, cookie: admin },
      payload: { ...form, testLogin: ann, testPassword: 'nope' },
    });
    expect(bad.json()).toMatchObject({ ok: false, error: expect.stringContaining('refused') });
  });

  it('someone with their own password connects on My settings, never by email alone', async () => {
    resetLoginLimiter();
    expect((await login(dee, `${dee}-directory-pw`)).statusCode).toBe(401);
    const mine = await t.login(`${dee}@example.com`, 'dee-own-password-12');
    const connect = (password: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/me/identities/ldap',
        headers: { ...H, cookie: mine },
        payload: { login: dee, password },
      });
    expect((await connect('wrong-password')).statusCode).toBe(400);
    expect((await connect(`${dee}-directory-pw`)).statusCode).toBe(200);
    resetLoginLimiter();
    expect((await login(dee, `${dee}-directory-pw`)).statusCode).toBe(200);
  });

  it('directoryCheck disables someone removed from the directory, and only them (§4.5)', async () => {
    resetLoginLimiter();
    expect((await login(cat, `${cat}-directory-pw`)).statusCode).toBe(200); // connects cat
    await gql(`mutation { deleteUser(userId: "${cat}") { ok } }`);
    await checkDirectory({ db: t.db, log: { info: () => {}, warn: () => {} } });
    const active = async (who: string) =>
      (
        await t.db
          .select()
          .from(users)
          .where(eq(users.email, `${who}@example.com`))
      )[0]!.isActive;
    expect(await active(cat)).toBe(false);
    expect(await active(ann)).toBe(true);
  });

  it.skipIf(!LDAPS)('LDAPS with a private CA (NODE_EXTRA_CA_CERTS)', async () => {
    resetLoginLimiter();
    await setSetting(t.db, 'auth.ldap', settings(LDAPS));
    try {
      expect((await login(ann, `${ann}-directory-pw`)).statusCode).toBe(200);
    } finally {
      await setSetting(t.db, 'auth.ldap', settings());
    }
  });
});
