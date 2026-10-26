// SPDX-License-Identifier: AGPL-3.0-or-later
// 12 S2: OpenID Connect sign-in, connect, disconnect, modes and signing out, against a fake
// provider (test/fake-oidc.ts).
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/crypto/secrets.ts';
import { sessions, userIdentities, users } from '../src/db/schema.ts';
import { resetLoginLimiter } from '../src/auth/login-limiter.ts';
import { setSetting } from '../src/services/settings.ts';
import type { OidcSettings } from '../src/sso/oidc.ts';
import { checkOidcSessions } from '../src/sso/oidcCheck.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';
import { startFakeOidc } from './fake-oidc.ts';

for (const alg of ['RS256', 'ES256'] as const)
  describe.skipIf(!hasTestDb)(`OpenID Connect (12 S2, ${alg})`, () => {
    let t: Awaited<ReturnType<typeof createTestApp>>;
    let idp: Awaited<ReturnType<typeof startFakeOidc>>;
    let admin: string;
    let oidcSettings: OidcSettings;

    beforeAll(async () => {
      idp = await startFakeOidc(alg);
      t = await createTestApp();
      await t.clearMustChange(ADMIN.email);
      admin = await t.login(ADMIN.email, ADMIN.password);
      oidcSettings = {
        label: 'Keycloak',
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecretEnc: encrypt(idp.clientSecret),
        scopes: 'openid email profile',
        groupsClaim: 'groups',
        adminGroups: [],
        allowedGroups: [],
        trustEmail: false,
      };
      await setSetting(t.db, 'auth.oidc', oidcSettings);
      await setSetting(t.db, 'auth.mode', 'mixed');
    });
    afterAll(async () => {
      await t?.close();
      await idp?.close();
    });
    beforeEach(() => {
      resetLoginLimiter();
      idp.st.tamper = {};
      idp.st.user = { sub: 'u-1', email: 'ann@example.com', email_verified: true };
      idp.st.refreshOk = true;
      idp.st.down = false;
      idp.st.refreshIdToken = true;
    });

    /** The browser's round trip: start → provider → callback. */
    async function flow(cookie?: string, query = '') {
      const connecting = query === '?connect=1';
      // Connect is a POST from My account (with the CSRF header); sign-in a GET from the button.
      const start = connecting
        ? await t.app.inject({
            method: 'POST',
            url: '/api/auth/oidc/connect',
            headers: { ...H, cookie: cookie! },
            payload: {},
          })
        : await t.app.inject({
            url: `/api/auth/oidc/start${query}`,
            headers: cookie ? { cookie } : {},
          });
      const location = connecting ? (start.json() as { url: string }).url : start.headers.location;
      expect(start.statusCode).toBe(connecting ? 200 : 302);
      const pending = start.cookies.find((c) => c.name === 'sp_oidc');
      if (!pending) return { start, callback: null };
      const atIdp = await fetch(location as string, { redirect: 'manual' });
      const back = new URL(atIdp.headers.get('location')!);
      expect(back.origin).toBe('https://pbx.test');
      const callback = await t.app.inject({
        url: back.pathname + back.search,
        headers: { cookie: [`sp_oidc=${pending.value}`, cookie].filter(Boolean).join('; ') },
      });
      return { start, callback };
    }
    const session = (r: { cookies: { name: string; value: string }[] }) => {
      const c = r.cookies.find((x) => x.name === 'sp_session');
      return c ? `sp_session=${c.value}` : null;
    };
    const errorOf = (r: { headers: Record<string, unknown> }) =>
      new URL(r.headers.location as string, 'https://pbx.test').searchParams.get('sso_error');

    it('methods show the button in mixed mode', async () => {
      const r = await t.app.inject({ url: '/api/auth/methods' });
      expect(r.json()).toEqual({ mode: 'mixed', ldap: false, oidc: { label: 'Keycloak' } });
    });

    it('never sends the browser to another site after sign-in (a tab, a backslash, //)', async () => {
      await t.addUser('nextcheck@example.com', 'next-check-pw-1');
      idp.st.user = { sub: 'u-next', email: 'nextcheck@example.com', email_verified: true };
      const pw = await t.login('nextcheck@example.com', 'next-check-pw-1');
      await flow(pw, '?connect=1');
      for (const next of [
        '/\t/evil.example',
        '/\n/evil.example',
        '/\\evil.example',
        '//evil.example',
      ])
        expect(
          (await flow(undefined, `?next=${encodeURIComponent(next)}`)).callback!.headers.location,
        ).toBe('/');
      expect((await flow(undefined, '?next=/me/calls')).callback!.headers.location).toBe(
        '/me/calls',
      );
    });

    it('connect is a POST with the CSRF header; a GET with connect=1 only signs in', async () => {
      const ann = await t.login(ADMIN.email, ADMIN.password);
      const forged = await t.app.inject({
        method: 'POST',
        url: '/api/auth/oidc/connect',
        headers: { cookie: ann },
        payload: {},
      });
      expect(forged.statusCode).toBe(403);
      expect(forged.json().error.code).toBe('csrf');
      const r = await t.app.inject({
        url: '/api/auth/oidc/start?connect=1',
        headers: { cookie: ann },
      });
      const pending = r.cookies.find((c) => c.name === 'sp_oidc')!;
      expect(JSON.parse(decrypt(pending.value)).connectSessionId).toBeNull();
    });

    it('starts with PKCE S256, state and nonce, and a short-lived cookie', async () => {
      const r = await t.app.inject({ url: '/api/auth/oidc/start?next=/me/calls' });
      const to = new URL(r.headers.location as string);
      expect(to.origin).toBe(idp.issuer);
      for (const p of ['state', 'nonce', 'code_challenge'])
        expect(to.searchParams.get(p)).toBeTruthy();
      expect(to.searchParams.get('code_challenge_method')).toBe('S256');
      expect(to.searchParams.get('redirect_uri')).toBe('https://pbx.test/api/auth/oidc/callback');
      expect(r.cookies.find((c) => c.name === 'sp_oidc')).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/api/auth/oidc',
        maxAge: 600,
      });
    });

    it('an account nobody connected is refused, and no user is made', async () => {
      idp.st.user = { sub: 'stranger', email: 'stranger@example.com', email_verified: true };
      const { callback } = await flow();
      expect(errorOf(callback!)).toBe('not_connected');
      expect(session(callback!)).toBeNull();
      const [u] = await t.db.select().from(users).where(eq(users.email, 'stranger@example.com'));
      expect(u).toBeUndefined();
    });

    it('a user with a password is never matched by email, even verified', async () => {
      await t.addUser('ann@example.com', 'ann-password-12');
      const { callback } = await flow();
      expect(errorOf(callback!)).toBe('not_connected');
    });

    it('connects from My account, then signs in either way', async () => {
      const ann = await t.login('ann@example.com', 'ann-password-12');
      const { callback } = await flow(ann, '?connect=1');
      expect(callback!.headers.location).toBe('/me/settings?sso=connected');
      const me = await t.app.inject({ url: '/api/auth/me', headers: { cookie: ann } });
      expect(me.json().user.signIn).toEqual({
        password: true,
        oidc: { email: 'ann@example.com', groups: [] },
        ldap: false,
      });
      const signIn = await flow(undefined, '?next=/me/calls');
      expect(signIn.callback!.headers.location).toBe('/me/calls');
      const cookie = session(signIn.callback!);
      expect(cookie).toBeTruthy();
      const [s] = await t.db
        .select()
        .from(sessions)
        .where(eq(sessions.method, 'oidc'))
        .orderBy(sessions.createdAt);
      expect(s!.idpRefreshEnc).toBeTruthy();
      expect(s!.idpIdTokenEnc).toBeTruthy();
      // …and the password still works.
      expect(await t.login('ann@example.com', 'ann-password-12')).toBeTruthy();
    });

    it("refuses to connect an account that's someone else's", async () => {
      await t.addUser('bob@example.com', 'bob-password-12');
      const bob = await t.login('bob@example.com', 'bob-password-12');
      const { callback } = await flow(bob, '?connect=1'); // the fake still signs in as u-1 (Ann)
      expect(errorOf(callback!)).toBe('taken');
    });

    it('matches a user without a password once, by verified email', async () => {
      const [u] = await t.db
        .insert(users)
        .values({ email: 'cara@example.com', displayName: 'Cara', passwordHash: null })
        .returning();
      idp.st.user = { sub: 'u-cara', email: 'cara@example.com', email_verified: false };
      expect(errorOf((await flow()).callback!)).toBe('not_connected');
      idp.st.user.email_verified = true;
      const { callback } = await flow();
      expect(session(callback!)).toBeTruthy();
      const ids = await t.db.select().from(userIdentities).where(eq(userIdentities.userId, u!.id));
      expect(ids).toMatchObject([{ kind: 'oidc', subject: `${idp.issuer} u-cara` }]);
    });

    it('trustEmail matches an unverified email', async () => {
      await t.db
        .insert(users)
        .values({ email: 'dee@example.com', displayName: 'Dee', passwordHash: null });
      idp.st.user = { sub: 'u-dee', email: 'dee@example.com' };
      await setSetting(t.db, 'auth.oidc', { ...oidcSettings, trustEmail: true });
      try {
        expect(session((await flow()).callback!)).toBeTruthy();
      } finally {
        await setSetting(t.db, 'auth.oidc', oidcSettings);
      }
    });

    for (const [name, tamper] of [
      ['a wrong nonce', { nonce: true }],
      ['a wrong issuer', { iss: true }],
      ['a wrong audience', { aud: true }],
      ['an expired ID token', { expired: true }],
      ['a bad signature', { signature: true }],
      ['a userinfo subject that differs', { userinfoSub: true }],
    ] as const)
      it(`refuses ${name}`, async () => {
        idp.st.tamper = tamper;
        const { callback } = await flow();
        expect(errorOf(callback!)).toBe('provider');
        expect(session(callback!)).toBeNull();
      });

    it('refuses a callback without our cookie, or with another state', async () => {
      const r = await t.app.inject({ url: '/api/auth/oidc/callback?code=x&state=y' });
      expect(errorOf(r)).toBe('expired');
      const start = await t.app.inject({ url: '/api/auth/oidc/start' });
      const pending = start.cookies.find((c) => c.name === 'sp_oidc')!;
      const atIdp = await fetch(start.headers.location as string, { redirect: 'manual' });
      const back = new URL(atIdp.headers.get('location')!);
      back.searchParams.set('state', 'forged');
      const forged = await t.app.inject({
        url: back.pathname + back.search,
        headers: { cookie: `sp_oidc=${pending.value}` },
      });
      expect(errorOf(forged)).toBe('provider');
    });

    it('the provider saying access_denied is "denied"', async () => {
      const start = await t.app.inject({ url: '/api/auth/oidc/start' });
      const pending = start.cookies.find((c) => c.name === 'sp_oidc')!;
      const r = await t.app.inject({
        url: '/api/auth/oidc/callback?error=access_denied&state=x',
        headers: { cookie: `sp_oidc=${pending.value}` },
      });
      expect(errorOf(r)).toBe('denied');
    });

    it('groups: allowedGroups refuses, adminGroups sets the role', async () => {
      idp.st.user = { sub: 'u-1', email: 'ann@example.com', groups: ['pbx-admins'] };
      await setSetting(t.db, 'auth.oidc', { ...oidcSettings, allowedGroups: ['pbx-users'] });
      expect(errorOf((await flow()).callback!)).toBe('not_allowed');
      await setSetting(t.db, 'auth.oidc', { ...oidcSettings, adminGroups: ['pbx-admins'] });
      try {
        const { callback } = await flow();
        const me = await t.app.inject({
          url: '/api/auth/me',
          headers: { cookie: session(callback!)! },
        });
        expect(me.json().user.role).toBe('admin');
        const [id] = await t.db
          .select()
          .from(userIdentities)
          .where(eq(userIdentities.subject, `${idp.issuer} u-1`));
        expect(id!.groups).toEqual(['pbx-admins']);
        idp.st.user.groups = [];
        await flow();
        const [ann] = await t.db.select().from(users).where(eq(users.email, 'ann@example.com'));
        expect(ann!.role).toBe('user');
      } finally {
        await setSetting(t.db, 'auth.oidc', oidcSettings);
      }
    });

    it('signing out of an OpenID session sends the browser to the provider', async () => {
      const { callback } = await flow();
      const out = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { ...H, cookie: session(callback!)! },
      });
      const to = new URL(out.json().redirect);
      expect(to.href.startsWith(`${idp.issuer}/logout`)).toBe(true);
      expect(to.searchParams.get('id_token_hint')).toBeTruthy();
      expect(to.searchParams.get('post_logout_redirect_uri')).toBe('https://pbx.test/login');
      // A password session signs out here only.
      const pw = await t.login('ann@example.com', 'ann-password-12');
      const out2 = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { ...H, cookie: pw },
      });
      expect(out2.json()).toEqual({ ok: true });
    });

    it('OpenID-only mode: passwords for admins only; disconnect keeps a way in', async () => {
      await setSetting(t.db, 'auth.mode', 'oidc');
      try {
        const r = await t.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: H,
          payload: { login: 'ann@example.com', password: 'ann-password-12' },
        });
        expect(r.json().error.code).toBe('password_sign_in_off');
        const { callback } = await flow();
        const ann = session(callback!)!;
        const d = await t.app.inject({
          method: 'DELETE',
          url: '/api/me/identities/oidc',
          headers: { ...H, cookie: ann },
        });
        expect(d.statusCode).toBe(409);
        expect(d.json().error.code).toBe('last_way_in');
      } finally {
        await setSetting(t.db, 'auth.mode', 'mixed');
      }
      // Mixed: Ann still has her password, so she may disconnect; OpenID sessions end.
      const { callback } = await flow();
      const ann = session(callback!)!;
      const [row] = await t.db.select().from(users).where(eq(users.email, 'ann@example.com'));
      const d = await t.app.inject({
        method: 'DELETE',
        url: `/api/users/${row!.id}/identities/oidc`,
        headers: { ...H, cookie: admin },
      });
      expect(d.statusCode).toBe(200);
      const left = await t.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, row!.id), eq(sessions.method, 'oidc')));
      expect(left).toEqual([]);
      expect(
        (await t.app.inject({ url: '/api/auth/me', headers: { cookie: ann } })).statusCode,
      ).toBe(401);
    });

    it('settings: Test, the secret write-only, and the mode needing a working provider', async () => {
      const form = {
        label: 'Keycloak',
        issuer: idp.issuer,
        clientId: idp.clientId,
        scopes: 'openid email profile',
        groupsClaim: 'groups',
        adminGroups: [],
        allowedGroups: [],
        trustEmail: false,
      };
      const req = (method: 'GET' | 'PATCH' | 'POST', url: string, payload?: object) =>
        t.app.inject({ method, url, payload, headers: { ...H, cookie: admin } });
      const ok = await req('POST', '/api/settings/auth/oidc/test', form);
      expect(ok.json()).toMatchObject({
        ok: true,
        pkce: true,
        refreshTokens: true,
        endSession: true,
      });
      const bad = await req('POST', '/api/settings/auth/oidc/test', {
        ...form,
        clientSecret: 'wrong',
      });
      expect(bad.json()).toMatchObject({ ok: false });
      expect((await req('PATCH', '/api/settings', { 'auth.oidc': form })).statusCode).toBe(200);
      const got = (await req('GET', '/api/settings')).json()['auth.oidc'];
      expect(got).toMatchObject({ hasClientSecret: true, label: 'Keycloak' });
      expect(JSON.stringify(got)).not.toContain('clientSecretEnc');
      const broken = await req('PATCH', '/api/settings', {
        'auth.oidc': { ...form, issuer: 'http://127.0.0.1:1' },
      });
      expect(broken.statusCode).toBe(400);
      const remote = await req('PATCH', '/api/settings', {
        'auth.oidc': { ...form, issuer: 'http://kc.example.com/realms/x' },
      });
      expect(remote.json().error.message).toContain('https');
    });

    /** Ann's OpenID session, connected again (an earlier test disconnects her). */
    async function annSession() {
      const pw = await t.login('ann@example.com', 'ann-password-12');
      await flow(pw, '?connect=1');
      const { callback } = await flow();
      const cookie = session(callback!)!;
      const [row] = await t.db
        .select()
        .from(sessions)
        .where(eq(sessions.method, 'oidc'))
        .orderBy(desc(sessions.idpCheckedAt))
        .limit(1);
      return { cookie, id: row!.id };
    }
    const later = (min: number) => new Date(Date.now() + min * 60_000);
    const check = (min: number) => checkOidcSessions({ db: t.db, log: t.app.log, now: later(min) });
    const row = async (id: string) =>
      (await t.db.select().from(sessions).where(eq(sessions.id, id)))[0];

    it('the session check: kept while the provider says yes, ended when it says no (§3.5)', async () => {
      const { cookie, id } = await annSession();
      const signedIn = (await row(id))!.idpCheckedAt!.getTime();
      await check(5); // checked at sign-in: not due yet
      expect((await row(id))!.idpCheckedAt!.getTime()).toBe(signedIn);
      await check(16);
      expect((await row(id))!.idpCheckedAt!.getTime()).toBeGreaterThan(signedIn);

      idp.st.down = true; // an outage signs no one out
      await check(40);
      expect(await row(id)).toBeTruthy();
      idp.st.down = false;

      idp.st.user = { ...idp.st.user, groups: ['pbx-admins'] };
      await setSetting(t.db, 'auth.oidc', { ...oidcSettings, adminGroups: ['pbx-admins'] });
      try {
        await check(56); // groups changed at the provider: the role follows
        const [ann] = await t.db.select().from(users).where(eq(users.email, 'ann@example.com'));
        expect(ann!.role).toBe('admin');
        await t.db.update(users).set({ role: 'user' }).where(eq(users.id, ann!.id));
      } finally {
        await setSetting(t.db, 'auth.oidc', oidcSettings);
      }

      idp.st.refreshOk = false; // disabled at the provider
      await check(72);
      expect(await row(id)).toBeUndefined();
      expect((await t.app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(
        401,
      );
    });

    it('the session check ends a session no longer in the allowed groups', async () => {
      idp.st.user = { ...idp.st.user, groups: ['pbx-users'] };
      await setSetting(t.db, 'auth.oidc', { ...oidcSettings, allowedGroups: ['pbx-users'] });
      try {
        const { id } = await annSession();
        idp.st.user.groups = [];
        await check(20);
        expect(await row(id)).toBeUndefined();
      } finally {
        await setSetting(t.db, 'auth.oidc', oidcSettings);
      }
    });

    it('the session check reads roles that are only in the ID token, and keeps a session whose refresh brings no groups', async () => {
      idp.st.user = { ...idp.st.user, roles: ['pbx-users'] }; // Entra: app roles, ID token only
      await setSetting(t.db, 'auth.oidc', {
        ...oidcSettings,
        groupsClaim: 'roles',
        allowedGroups: ['pbx-users'],
      });
      try {
        const { id } = await annSession();
        await check(20);
        expect(await row(id)).toBeTruthy();
        idp.st.refreshIdToken = false; // no new ID token: no roles claim at all
        await check(40);
        expect(await row(id)).toBeTruthy();
        idp.st.refreshIdToken = true;
        idp.st.user.roles = []; // the claim is there, and empty: ended
        await check(60);
        expect(await row(id)).toBeUndefined();
      } finally {
        await setSetting(t.db, 'auth.oidc', oidcSettings);
      }
    });
  });
