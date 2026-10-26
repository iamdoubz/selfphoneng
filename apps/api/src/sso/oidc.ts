// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenID Connect relying party (12 §3) on openid-client: discovery, PKCE + state + nonce, the
// code grant, userinfo, test, signing out at the provider. No protocol code of our own.
import * as oidc from 'openid-client';
import type { OidcTestResult, SettingValue } from '@selfphoneng/shared';
import { decrypt } from '../crypto/secrets.ts';

export type OidcSettings = NonNullable<SettingValue<'auth.oidc'>>;

/** http:// only for the fake provider in tests; a real provider is always https (12 §3.1). */
const insecureOk = (u: URL) =>
  process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(u.hostname);

export function assertIssuer(issuer: string): void {
  const u = new URL(issuer);
  if (u.protocol !== 'https:' && !insecureOk(u)) throw new Error('The issuer must be https://');
}

export const redirectUri = (host: string) => `https://${host}/api/auth/oidc/callback`;
export const postLogoutUri = (host: string) => `https://${host}/login`;

let cached: { key: string; config: oidc.Configuration } | null = null;

/**
 * Discovers the provider once per settings value (a change or a failure means the next call
 * discovers again) and picks client_secret_basic, else _post, else none for a public client.
 */
export async function oidcConfig(s: OidcSettings): Promise<oidc.Configuration> {
  const key = JSON.stringify(s);
  if (cached?.key === key) return cached.config;
  const issuer = new URL(s.issuer);
  assertIssuer(s.issuer);
  const insecure = insecureOk(issuer);
  const found = await oidc.discovery(issuer, s.clientId, undefined, oidc.None(), {
    timeout: 5,
    ...(insecure && { execute: [oidc.allowInsecureRequests] }),
  });
  const meta = found.serverMetadata();
  const secret = s.clientSecretEnc ? decrypt(s.clientSecretEnc) : null;
  const methods = meta.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  const auth = !secret
    ? oidc.None()
    : methods.includes('client_secret_basic') || !methods.includes('client_secret_post')
      ? oidc.ClientSecretBasic(secret)
      : oidc.ClientSecretPost(secret);
  const config = new oidc.Configuration(meta, s.clientId, undefined, auth);
  config.timeout = 5;
  // Check ID token signatures too (by default TLS to the token endpoint is trusted instead).
  oidc.enableNonRepudiationChecks(config);
  if (insecure) oidc.allowInsecureRequests(config);
  cached = { key, config };
  return config;
}

/** What the sp_oidc cookie holds between start and callback (12 §3.2). */
export type PendingSignIn = {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  /** Connecting from My account: the session that asked (12 §3.3). */
  connectSessionId: string | null;
  exp: number;
};

export async function startSignIn(
  s: OidcSettings,
  host: string,
  next: string,
  connectSessionId: string | null,
): Promise<{ url: URL; pending: PendingSignIn }> {
  const config = await oidcConfig(s);
  const pending: PendingSignIn = {
    state: oidc.randomState(),
    nonce: oidc.randomNonce(),
    verifier: oidc.randomPKCECodeVerifier(),
    next,
    connectSessionId,
    exp: Date.now() + 600_000,
  };
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(host),
    scope: s.scopes,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(pending.verifier),
    code_challenge_method: 'S256',
  });
  return { url, pending };
}

export type SignInResult = {
  /** "<iss> <sub>" (12 §2). */
  subject: string;
  /** The ID token's claims, then userinfo's on top. */
  claims: Record<string, unknown>;
  idToken: string;
  refreshToken: string | null;
};

/** Checks the provider's answer (state, PKCE, nonce, ID token) and reads userinfo. */
export async function finishSignIn(
  s: OidcSettings,
  currentUrl: URL,
  pending: PendingSignIn,
): Promise<SignInResult> {
  const config = await oidcConfig(s);
  const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: pending.verifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });
  const id = tokens.claims()!;
  let claims: Record<string, unknown> = { ...id };
  // Several providers put email or groups only in userinfo (12 §3.2 step 4).
  if (config.serverMetadata().userinfo_endpoint)
    claims = { ...claims, ...(await oidc.fetchUserInfo(config, tokens.access_token, id.sub)) };
  return {
    subject: `${id.iss} ${id.sub}`,
    claims,
    idToken: tokens.id_token!,
    refreshToken: tokens.refresh_token ?? null,
  };
}

/** RP-initiated logout (12 §3.5): where to send the browser, or null when the provider can't. */
export async function endSessionUrl(
  s: OidcSettings,
  host: string,
  idToken: string,
): Promise<string | null> {
  const config = await oidcConfig(s);
  if (!config.serverMetadata().end_session_endpoint) return null;
  return oidc
    .buildEndSessionUrl(config, {
      id_token_hint: idToken,
      post_logout_redirect_uri: postLogoutUri(host),
    })
    .toString();
}

/** A provider error as one line for the log and the admin (never a token). */
export function oidcError(err: unknown): string {
  if (err instanceof oidc.ResponseBodyError)
    return `${err.error}${err.error_description ? `: ${err.error_description}` : ''}`;
  if (err instanceof oidc.AuthorizationResponseError)
    return `${err.error}${err.error_description ? `: ${err.error_description}` : ''}`;
  return (err as Error).message;
}

/**
 * Settings → Sign-in → Test (12 §3.1): discovery, then a code grant with a code that can't
 * exist: `invalid_grant` means the client id and secret were accepted.
 */
export async function testOidc(s: OidcSettings, host: string): Promise<OidcTestResult> {
  try {
    cached = null;
    const config = await oidcConfig(s);
    const meta = config.serverMetadata();
    try {
      await oidc.genericGrantRequest(config, 'authorization_code', {
        code: 'selfphoneng-test-not-a-code',
        redirect_uri: redirectUri(host),
        code_verifier: oidc.randomPKCECodeVerifier(),
      });
    } catch (err) {
      const code = err instanceof oidc.ResponseBodyError ? err.error : null;
      if (code === 'invalid_client' || code === 'unauthorized_client')
        return { ok: false, error: `The provider refused the client ID or secret (${code})` };
      if (code !== 'invalid_grant' && code !== 'invalid_request')
        return { ok: false, error: `The token endpoint answered: ${oidcError(err)}` };
    }
    return {
      ok: true,
      issuer: meta.issuer,
      algorithms: meta.id_token_signing_alg_values_supported ?? [],
      pkce: meta.code_challenge_methods_supported?.includes('S256') ?? false,
      refreshTokens: meta.grant_types_supported?.includes('refresh_token') ?? false,
      endSession: Boolean(meta.end_session_endpoint),
      redirectUri: redirectUri(host),
      postLogoutRedirectUri: postLogoutUri(host),
    };
  } catch (err) {
    return { ok: false, error: oidcError(err) };
  }
}
