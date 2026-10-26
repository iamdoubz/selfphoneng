# 0004 — openid-client and ldapts for single sign-on

Owner, 2026-10-25: sign-in with an OpenID Connect provider and with an LDAP directory (spec 12).
Both protocols are security code we must not write ourselves: OIDC needs PKCE, state/nonce, ID
token signature and claim checks, `iss` response checks and JWKS rotation; LDAP needs BER encoding,
StartTLS and RFC 4515 filter escaping. **openid-client** 6.x (panva, MIT) is the reference
certified OpenID relying party library for Node; its only dependencies, `oauth4webapi` and `jose`,
are the same author's and MIT. **ldapts** (MIT, TypeScript, promise API) is the maintained LDAP
client (`ldapjs` was decommissioned in 2024) and has `escapeFilter`. Both are open source with no
native code. No OIDC test server is added: the tests use a small fake provider on `node:http`
and `node:crypto`, and live tests run against a real Keycloak and lldap.
