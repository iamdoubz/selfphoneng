// SPDX-License-Identifier: AGPL-3.0-or-later
// 12 S3 against a real Keycloak: connect, sign in through Keycloak's own login form, a group
// makes an admin, signing out there too, and disabling the user there ending our session.
// Needs KEYCLOAK_LIVE_URL (e.g. http://127.0.0.1:18080) and KEYCLOAK_LIVE_ADMIN ("user:password"
// of the master realm); makes a throwaway realm and deletes it. Passed against 26.8.1:
//   docker run -d -p 127.0.0.1:18080:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
//     -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin quay.io/keycloak/keycloak:26.8.1 start-dev
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto/secrets.ts';
import { sessions, users } from '../src/db/schema.ts';
import { setSetting } from '../src/services/settings.ts';
import { checkOidcSessions } from '../src/sso/oidcCheck.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const KC = process.env.KEYCLOAK_LIVE_URL;
const [KC_USER, KC_PASS] = (process.env.KEYCLOAK_LIVE_ADMIN ?? 'admin:admin').split(':');

/** A cookie jar for the browser's side of Keycloak. */
class Browser {
  jar = new Map<string, string>();
  async get(url: string, init: RequestInit = {}) {
    const res = await fetch(url, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers as object), cookie: this.cookie() },
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv!.indexOf('=');
      this.jar.set(kv!.slice(0, i), kv!.slice(i + 1));
    }
    return res;
  }
  cookie = () => [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

describe.skipIf(!hasTestDb || !KC)('OpenID Connect with a real Keycloak (12 S3)', () => {
  const realm = `sp-test-${randomBytes(4).toString('hex')}`;
  const issuer = `${KC}/realms/${realm}`;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let token: string;
  let kcUserId: string;
  const browser = new Browser();

  const kcAdmin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${KC}/admin/realms${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res;
  };

  beforeAll(async () => {
    const tok = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: KC_USER!,
        password: KC_PASS!,
      }),
    });
    token = ((await tok.json()) as { access_token: string }).access_token;
    await kcAdmin('POST', '', { realm, enabled: true });
    await kcAdmin('POST', `/${realm}/clients`, {
      clientId: 'selfphoneng',
      protocol: 'openid-connect',
      publicClient: false,
      secret: 'live-secret-with-symbols-+/=',
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: ['https://pbx.test/api/auth/oidc/callback'],
      attributes: { 'post.logout.redirect.uris': 'https://pbx.test/login' },
      protocolMappers: [
        {
          name: 'groups',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-group-membership-mapper',
          config: {
            'full.path': 'false',
            'id.token.claim': 'true',
            'access.token.claim': 'true',
            'userinfo.token.claim': 'true',
            'claim.name': 'groups',
          },
        },
      ],
    });
    await kcAdmin('POST', `/${realm}/groups`, { name: 'pbx-admins' });
    const u = await kcAdmin('POST', `/${realm}/users`, {
      username: 'ann',
      email: 'ann@example.com',
      emailVerified: true,
      firstName: 'Ann',
      lastName: 'Lee',
      enabled: true,
      groups: ['/pbx-admins'],
      credentials: [{ type: 'password', value: 'ann-keycloak-pw', temporary: false }],
    });
    kcUserId = u.headers.get('location')!.split('/').at(-1)!;

    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    await t.addUser('ann@example.com', 'ann-password-12');
    await setSetting(t.db, 'auth.oidc', {
      label: 'Keycloak',
      issuer,
      clientId: 'selfphoneng',
      clientSecretEnc: encrypt('live-secret-with-symbols-+/='),
      scopes: 'openid email profile',
      groupsClaim: 'groups',
      adminGroups: ['pbx-admins'],
      allowedGroups: [],
      trustEmail: false,
    });
    await setSetting(t.db, 'auth.mode', 'mixed');
  }, 60_000);

  afterAll(async () => {
    await t?.close();
    if (token) await kcAdmin('DELETE', `/${realm}`).catch(() => {});
  });

  /** start → Keycloak's login form, filled in like a person would → our callback. */
  async function flow(cookie?: string, query = '') {
    const start = await t.app.inject({
      url: `/api/auth/oidc/start${query}`,
      headers: cookie ? { cookie } : {},
    });
    const pending = start.cookies.find((c) => c.name === 'sp_oidc')!;
    let res = await browser.get(start.headers.location as string);
    if (res.status === 200) {
      // Not signed in at Keycloak yet: post its login form.
      const html = await res.text();
      const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)![1]!;
      res = await browser.get(action.replaceAll('&amp;', '&'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'ann', password: 'ann-keycloak-pw' }).toString(),
      });
    }
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!);
    expect(back.origin).toBe('https://pbx.test');
    return t.app.inject({
      url: back.pathname + back.search,
      headers: { cookie: [`sp_oidc=${pending.value}`, cookie].filter(Boolean).join('; ') },
    });
  }
  const session = (r: Awaited<ReturnType<typeof flow>>) => {
    const c = r.cookies.find((x) => x.name === 'sp_session');
    return c ? `sp_session=${c.value}` : null;
  };

  it('Test sees the realm and accepts the client', async () => {
    const admin = await t.login(ADMIN.email, ADMIN.password);
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/settings/auth/oidc/test',
      headers: { ...H, cookie: admin },
      payload: {
        label: 'Keycloak',
        issuer,
        clientId: 'selfphoneng',
        scopes: 'openid email profile',
        groupsClaim: 'groups',
        adminGroups: [],
        allowedGroups: [],
        trustEmail: false,
      },
    });
    expect(r.json()).toMatchObject({ ok: true, pkce: true, refreshTokens: true, endSession: true });
  });

  it('connects, signs in through the login form, and the group makes an admin', async () => {
    const pw = await t.login('ann@example.com', 'ann-password-12');
    const c = await flow(pw, '?connect=1');
    expect(c.headers.location).toBe('/me/settings?sso=connected');
    const r = await flow();
    const cookie = session(r);
    expect(cookie).toBeTruthy();
    const me = (await t.app.inject({ url: '/api/auth/me', headers: { cookie: cookie! } })).json();
    expect(me.user).toMatchObject({ role: 'admin' });
    expect(me.user.signIn.oidc).toEqual({ email: 'ann@example.com', groups: ['pbx-admins'] });
  });

  it('signing out signs out of Keycloak too', async () => {
    const r = await flow(); // already signed in at Keycloak: straight back
    const out = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...H, cookie: session(r)! },
    });
    const to = out.json().redirect as string;
    expect(to.startsWith(`${issuer}/protocol/openid-connect/logout`)).toBe(true);
    const done = await browser.get(to);
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('https://pbx.test/login');
    // Keycloak forgot us: the next sign-in shows its login form again (flow() fills it).
    expect(session(await flow())).toBeTruthy();
  });

  it('disabling the user in Keycloak ends their session at the next check', async () => {
    const r = await flow();
    const cookie = session(r)!;
    const [ann] = await t.db.select().from(users).where(eq(users.email, 'ann@example.com'));
    const check = (min: number) =>
      checkOidcSessions({
        db: t.db,
        log: t.app.log,
        now: new Date(Date.now() + min * 60_000),
      });
    await check(16);
    expect((await t.app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
    await kcAdmin('PUT', `/${realm}/users/${kcUserId}`, { enabled: false });
    await check(32);
    const left = await t.db.select().from(sessions).where(eq(sessions.userId, ann!.id));
    expect(left.filter((s) => s.method === 'oidc')).toEqual([]);
    expect((await t.app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});
