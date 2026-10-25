// SPDX-License-Identifier: AGPL-3.0-or-later
// A small OpenID provider for tests (12 §6): discovery, JWKS, authorize, token (code + refresh,
// PKCE S256, client_secret_basic), userinfo, end session. `tamper` breaks one thing at a time.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeUser = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  /** Only in userinfo, as Keycloak's mappers and Authelia send them. */
  groups?: string[];
};

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export async function startFakeOidc(alg: 'RS256' | 'ES256' = 'RS256') {
  const pair =
    alg === 'RS256'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }); // signs "bad signature" tokens
  const clientId = 'selfphoneng';
  const clientSecret = 'fake-secret';
  const st = {
    user: { sub: 'u-1', email: 'ann@example.com', email_verified: true } as FakeUser,
    tamper: {} as {
      nonce?: boolean;
      iss?: boolean;
      aud?: boolean;
      expired?: boolean;
      signature?: boolean;
      userinfoSub?: boolean;
    },
    /** false: refresh tokens are refused, as for a user disabled at the provider. */
    refreshOk: true,
    refreshes: 0,
  };
  const codes = new Map<string, { nonce: string; challenge: string; user: FakeUser }>();
  const access = new Map<string, FakeUser>();
  const refresh = new Map<string, FakeUser>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: [alg],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    if (url.pathname === '/jwks')
      return json(200, {
        keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', alg, use: 'sig' }],
      });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== clientId || p.get('code_challenge_method') !== 'S256')
        return json(400, { error: 'invalid_request' });
      const code = b64u(randomBytes(16));
      codes.set(code, {
        nonce: p.get('nonce')!,
        challenge: p.get('code_challenge')!,
        user: { ...st.user },
      });
      const back = new URL(p.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state')!);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      // client_secret_basic: both parts form-encoded before base64 (RFC 6749 §2.3.1).
      const [id, secret] = Buffer.from(
        (req.headers.authorization ?? '').replace(/^Basic /, ''),
        'base64',
      )
        .toString()
        .split(':')
        .map((x) => decodeURIComponent(x.replace(/\+/g, ' ')));
      if (id !== clientId || secret !== clientSecret) return json(401, { error: 'invalid_client' });
      const form = new URLSearchParams(await body(req));
      if (form.get('grant_type') === 'refresh_token') {
        const user = refresh.get(form.get('refresh_token')!);
        st.refreshes++;
        if (!user || !st.refreshOk) return json(400, { error: 'invalid_grant' });
        return json(200, tokens(user, null));
      }
      const c = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (!c || b64u(createHash('sha256').update(verifier).digest()) !== c.challenge)
        return json(400, { error: 'invalid_grant' });
      return json(200, tokens(c.user, c.nonce));
    }
    if (url.pathname === '/userinfo') {
      const user = access.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!user) return json(401, { error: 'invalid_token' });
      return json(200, { ...user, ...(st.tamper.userinfoSub && { sub: 'someone-else' }) });
    }
    if (url.pathname === '/logout') return json(200, {});
    json(404, {});
  });

  function tokens(user: FakeUser, nonce: string | null) {
    const now = Math.floor(Date.now() / 1000);
    const t = st.tamper;
    const claims = {
      iss: t.iss ? 'https://evil.example' : issuer,
      sub: user.sub,
      aud: t.aud ? 'another-client' : clientId,
      iat: now,
      exp: t.expired ? now - 3600 : now + 300,
      ...(nonce && { nonce: t.nonce ? 'wrong-nonce' : nonce }),
      ...(user.email && { email: user.email, email_verified: user.email_verified }),
    };
    const at = b64u(randomBytes(16));
    const rt = b64u(randomBytes(16));
    access.set(at, user);
    refresh.set(rt, user);
    return {
      access_token: at,
      token_type: 'Bearer',
      expires_in: 300,
      refresh_token: rt,
      id_token: jwt(claims, t.signature ? other.privateKey : pair.privateKey),
    };
  }

  function jwt(claims: object, key: KeyObject) {
    const data = `${b64u(JSON.stringify({ alg, kid: 'k1', typ: 'JWT' }))}.${b64u(JSON.stringify(claims))}`;
    const sig =
      alg === 'RS256'
        ? sign('sha256', Buffer.from(data), key)
        : sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
    return `${data}.${b64u(sig)}`;
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    clientId,
    clientSecret,
    st,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function body(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}
