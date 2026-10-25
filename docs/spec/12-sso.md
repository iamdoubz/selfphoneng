# 12 — Single sign-on: OpenID Connect and LDAP

Owner, 2026-10-25: people can sign in to the web app (admin panel, user portal, browser softphone)
with the company's identity provider as well as, or instead of, a SelfPhoneNG password:

- **OpenID Connect** (S1–S3): "Sign in with Keycloak" on the login page. The owner's install uses
  Keycloak, but nothing here is Keycloak-only: any provider that follows OpenID Connect Core and
  Discovery works (§3.6 lists the ones checked).
- **LDAP / LDAPS** (S4–S5): the normal password form, checked against the company directory
  (Active Directory, OpenLDAP, FreeIPA, lldap, Samba AD, 389 DS …) when the SelfPhoneNG password
  doesn't match.

A user **connects** their OpenID account to their SelfPhoneNG account and can then sign in either
way: with their password or with the provider. The admin picks which ways are on (§1.1).

Only **web sign-in** changes. SIP passwords, voicemail PINs, desk phone provisioning, API tokens and
the softphone's SIP login are untouched: a phone never talks to the identity provider.

## 1. Rules that hold for both

- **Identities**: a user has a SelfPhoneNG password (or none), and at most one connected OpenID
  account and one directory account (`user_identities`, §2). Each is one more way to sign in to the
  same account; none replaces the others.
- **Who someone is at the provider** is its stable id, never the email or name: OIDC `iss` + `sub`,
  LDAP the entry's UUID attribute (`entryUUID`, `objectGUID`, `ipaUniqueID`, `nsUniqueId`).
- **No automatic accounts** (owner, 2026-10-25): signing in with a provider never creates a user.
  An admin creates every user on Users, as today; the provider only signs in users who exist.
- **Break glass**: the last active admin with a password can't be deleted, disabled or demoted
  (extends `assertNotLastAdmin`), and admins can always sign in with a password, even in
  OpenID-only mode (§1.1). The identity provider being down never locks the owner out.
- **One OIDC provider and one directory** per install. More than one OIDC provider: later (§7).
- **Role**: when the provider's admin mapping is set (`adminGroups`, `adminFilter`), the role
  follows it on every sign-in and check through that provider (§3.4, §4.4), and Users shows it
  read-only (`PATCH role` → 409 `role_managed`). Unset: the role is managed in SelfPhoneNG as now.
  A sync never demotes or disables the last active admin with a password (it keeps them and logs a
  warning).
- **Extensions** stay manual: an admin assigns one on Users.
- **Our own session**: every sign-in makes the same `sp_session` cookie as today (04 §2.2, 14 days,
  sliding). `sessions.method` says how it was made. Provider tokens never reach the browser.
- **Two-step sign-in** (08 §2.4, owner 2026-10-25): password sign-ins ask for our TOTP code when
  it's on, whether the password was checked here or by the directory. OpenID sign-ins don't: MFA
  there is the provider's job.
- **Self-signed or private CA** (a home-lab Keycloak or a domain controller): `NODE_EXTRA_CA_CERTS`
  (01 env list) names a PEM file mounted into the api container; Node then trusts it for both
  HTTPS and LDAPS. No "skip certificate check" switch anywhere.
- The api runs with host networking (01), so a Keycloak or directory on the LAN is reachable as is.
  Both settings are admin-only, so the webhook private-address block (04 §9) doesn't apply.
- **Never logged**: client secret, bind password, user passwords, authorization codes, ID/access/
  refresh tokens. The OIDC callback route is `logLevel: 'silent'` (its query holds the code, like
  the caller-name route, 11 §6.1) and writes its own line without the query.

### 1.1 Sign-in mode (`auth.mode`)

Settings → Sign-in, admin:

| Mode | Login page | `POST /api/auth/login` (password, local or directory) | OpenID |
|---|---|---|---|
| `password` (default) | the password form | everyone | off (start/callback answer 404) |
| `mixed` | the **Sign in with <label>** button and the password form | everyone | everyone with a connected account |
| `oidc` | the button only; a small **Admin sign-in** link shows the password form | **admins only**, everyone else 403 `password_sign_in_off` | everyone with a connected account |

- `mixed` and `oidc` need `auth.oidc` set up and its Test passed (PATCH → 400 otherwise).
- In `oidc` mode a user without a connected account can still get in once, by verified email
  (§3.3 step 2), so pre-made users work without a password. Settings shows "N people can't sign in
  yet" with their names: no connected account and an email the provider can't match.
- Switching modes signs no one out. Passwords are kept, only refused, so switching back works.
- In `mixed` mode the password stays a separate way in: disabling someone in Keycloak ends their
  Keycloak sign-ins (§3.5), but their password still works until they're disabled on Users. Settings
  says so next to the mode; `oidc` mode is the one where Keycloak alone decides.

## 2. Data

Migration (02 §users gets the table and these notes):

```sql
alter table users alter column password_hash drop not null; -- null: no password (made in oidc mode)

create type identity_kind as enum ('oidc', 'ldap');
create table user_identities (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  kind         identity_kind not null,
  subject      text not null,        -- oidc: "<iss> <sub>"; ldap: the UUID attribute's value
  email        text,                 -- as the provider last said, shown in My account and Users
  groups       text[] not null default '{}', -- oidc: groupsClaim values at the last sign-in (§3.4)
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  unique (kind, subject),
  unique (user_id, kind)
);

alter table sessions
  add column method text not null default 'password' check (method in ('password', 'ldap', 'oidc')),
  add column idp_refresh_enc  text,  -- oidc: refresh token, encrypt() (§3.5)
  add column idp_id_token_enc text,  -- oidc: ID token, encrypt(), for signing out there (§3.5)
  add column idp_checked_at   timestamptz;
```

Settings (02 §3), all admin-only, written by Settings → Sign-in, secrets write-only (`has…` in GET,
an empty value keeps the stored one), like `smtp`:

| Key | Type | Default | Notes |
|---|---|---|---|
| `auth.mode` | `'password' \| 'mixed' \| 'oidc'` | `'password'` | §1.1 |
| `auth.oidc` | object \| null | null | §3.1 |
| `auth.ldap` | object \| null | null | §4.1 |

`UserDto` and `AuthUser` (`/api/auth/me`) get
`signIn: { password: boolean, oidc: { email } | null, ldap: boolean }`.

Public route for the login page: `GET /api/auth/methods` →
`{ mode, ldap: boolean, oidc: { label } | null }`. Nothing else about the setup is public.

## 3. OpenID Connect

Library: **openid-client** 6.x (panva, MIT; its two dependencies `oauth4webapi` and `jose` are
the same author's, MIT). Decision 0004. It does discovery, PKCE, state and nonce checks, ID token
signature and claim checks (RS/PS/ES/EdDSA), RFC 9207 `iss` checks, JWKS caching and key
rotation, and builds the end-session URL. We don't hand-roll any of that.

### 3.1 Settings (`auth.oidc`)

```ts
{
  label: string,              // button text: "Sign in with <label>", e.g. "Keycloak"
  issuer: string,             // https URL; discovery reads <issuer>/.well-known/openid-configuration
  clientId: string,
  clientSecretEnc: string | null, // null: public client (PKCE only), for providers that allow it
  scopes: string,             // default "openid email profile"; add "groups", "offline_access" … per provider
  groupsClaim: string,        // dotted path, default "groups" (e.g. "realm_access.roles", "roles")
  adminGroups: string[],      // in groupsClaim → admin; others → user. [] = role managed here
  allowedGroups: string[],    // [] = anyone the provider signs in (who has an account here)
  trustEmail: boolean,        // default false: treat email as verified without email_verified (§3.3)
}
```

- On or off is `auth.mode` (§1.1), not a flag here.
- `issuer` must be `https:` (`http://localhost…` allowed for the fake provider only, `NODE_ENV=test`).
- Discovery runs on first use and is cached in memory; a settings change or a failed discovery
  forgets it. Client authentication: `client_secret_basic` when the provider lists it, else
  `client_secret_post`, else none for a public client (openid-client `ClientSecretBasic`,
  `ClientSecretPost`, `None`). `private_key_jwt`: later, if asked.
- Two fixed URIs, shown in Settings with Copy buttons, to register at the provider:
  - redirect URI `https://${PUBLIC_HOSTNAME}/api/auth/oidc/callback`;
  - post-logout redirect URI `https://${PUBLIC_HOSTNAME}/login` (§3.5).
- Response mode is the default `query` (a `form_post` POST wouldn't carry our SameSite=Lax cookie).
- **Test** (`POST /api/settings/auth/oidc/test`, from the unsaved form): discovery works, the issuer
  in the document equals `issuer` exactly, the token endpoint accepts the client (a deliberately bad
  `authorization_code` grant: `invalid_grant` means the client was accepted, `invalid_client` means
  it wasn't), and says which signing algorithms and whether PKCE, refresh tokens and an end-session
  endpoint are offered. The real check is the one Settings suggests next: connect your own account
  in My account.

### 3.2 Flow

1. Login page (`mixed`, `oidc`): **Sign in with <label>**, a plain link to
   `/api/auth/oidc/start?next=<path>` (same-site paths only, as `next` is today).
   My account: **Connect <label>**, a link to `/api/auth/oidc/start?connect=1` (needs a session).
2. `GET /api/auth/oidc/start`: 404 in `password` mode. Makes `state`, `nonce` and a PKCE verifier
   (always all three, even when the provider advertises PKCE), stores them with `next` (and, to
   connect, the session id) in the cookie `sp_oidc = encrypt(JSON)`;
   `HttpOnly; Secure; SameSite=Lax; Path=/api/auth/oidc; Max-Age=600`, and answers 302 to
   `buildAuthorizationUrl` (`code_challenge_method=S256`).
3. `GET /api/auth/oidc/callback` (`logLevel: 'silent'`): reads and clears `sp_oidc`, builds the
   current URL from `PUBLIC_HOSTNAME` and the path (never from the Host header), and calls
   `authorizationCodeGrant` with the verifier, `expectedState` and `expectedNonce`.
4. Claims: the ID token's, then **always** the userinfo endpoint's when the provider has one
   (`fetchUserInfo` with the ID token's `sub` as the expected subject), merged, userinfo winning.
   Several providers (Authelia, and Keycloak's mappers by default) put email or groups only in
   userinfo, so one rule covers them all.
5. `applyClaims` (§3.4): allowed, role, groups.
6. Connecting (§3.3 step 3) → back to My account with "Connected". Signing in → find the user
   (§3.3), make the session (`method = 'oidc'`, refresh and ID tokens kept, §3.5), set
   `last_login_at` and `last_used_at`, audit `login` "… signed in with Keycloak", 302 to `next` or
   the user's home.

Any failure: 302 to `/login?sso_error=<code>` (to `/me/account?sso_error=` when connecting), audit
`login_failed` with the reason, the provider's `error_description` in the log only:

| Code | When | Says |
|---|---|---|
| `expired` | no or bad `sp_oidc` (took over 10 min, or started in another tab) | "Sign-in took too long. Try again." |
| `denied` | the provider answered `error=access_denied` | "Sign-in was cancelled." |
| `not_allowed` | not in `allowedGroups` | "Your <label> account isn't allowed to use the phone system. Ask your admin." |
| `not_connected` | no user has this account, and none can be matched by email (§3.3) | "This <label> account isn't connected to a phone system account. Sign in with your password and connect it in My account, or ask your admin." |
| `taken` | connecting an account that's already someone else's | "This <label> account is already connected to another user." |
| `disabled` | the user is disabled here | "Your account is disabled." |
| `provider` | anything else (discovery, token endpoint, signature, clock) | "<label> sign-in didn't work. Your admin can see why in the log." |

Failed callbacks count in the IP login limiter (04 §2.2).

### 3.3 Finding the user, and connecting

Signing in, in this order:

1. A `user_identities` row (`oidc`, `"<iss> <sub>"`) → its user.
2. Else, a user with that email (case-insensitive) who has **no password and no OpenID account
   yet** (made by an admin in `oidc` mode, or whose password an admin removed), **and the email is
   verified** (`email_verified === true`, or `trustEmail`) → connect it now (step 3's row) and sign
   in. Users who have a password are never matched by email: they connect from My account, so a
   provider where people can set their own email can't hand over an account.
3. Else `not_connected`.

Connecting (from My account, already signed in, any mode but `password`):

- After the callback, the session's user gets the `user_identities` row (email and groups as
  sent). Refused (`taken`) when that `iss sub` belongs to another user; a user who already has one
  replaces it (confirm in the UI). Other sessions stay. Audit `sso_connected`.
- **Disconnect** (`DELETE /api/me/identities/oidc`; admins also on Users,
  `DELETE /api/users/:id/identities/oidc`): ends that user's `oidc` sessions. Refused (409
  `last_way_in`) when it would leave them no way to sign in in the current mode (no password, or
  `oidc` mode and not an admin). Audit `sso_disconnected`.
- A user without a password in `mixed` mode can get one from an admin (Users → Reset password, as
  today). Setting a password yourself without one: later, if asked.

`trustEmail` help text: "Turn on only if people can't change their own email address at <label>
(true for a single company's Keycloak with email editing off, or a single-tenant Entra ID)". The
issuer is pinned to one realm or tenant, so emails come from one admin's directory. It only
matters for step 2.

Users → Create: in `oidc` mode no temporary password is made (the person signs in by email, step
2); in the other modes as today.

### 3.4 Claims → allowed and role (`sso/claims.ts`, pure, unit-tested)

- `groupsClaim` is a dotted path into the merged claims. Its value becomes a string list: a string
  → `[s]`; an array → its strings; an object → its keys (Zitadel's
  `urn:zitadel:iam:org:project:roles` is `{ role: { orgId: domain } }`). Path lookup: the whole
  remaining path as one key first, else split on the first `.`, so a claim name with dots or
  colons and `resource_access.selfphoneng.roles` both work.
- Group names compare exactly (case-sensitive): Keycloak with "Full group path" on sends
  `/pbx-admins`, off sends `pbx-admins`; the admin types what their provider sends. They are stored
  on the identity (`groups`), and Users → a user shows them, to copy from.
- Allowed: `allowedGroups` empty or any match.
- Role: `adminGroups` empty → unchanged; else admin when any matches.

### 3.5 Leavers and signing out

**Session check** (`sso/oidcCheck.ts`, job every 5 min, owner 2026-10-25: keep it). Our session
lasts 14 days, so a person disabled in Keycloak must lose it sooner:

- Sessions with `method = 'oidc'`, a refresh token and `idp_checked_at` older than 15 min →
  `refreshTokenGrant`, store the new refresh and ID tokens when rotated, fetch userinfo with the new
  access token, run `applyClaims`. The provider refuses (`invalid_grant`: user disabled, session
  revoked, refresh token expired) or `applyClaims` says not allowed → delete that session (the live
  socket closes within 30 s, 04 §6). Role, groups and email changes apply. The provider unreachable
  or 5xx → keep the session, try next run (an outage doesn't sign everyone out).
- Only `oidc` sessions: password sessions of the same user are untouched (§1.1, `mixed`).
- No refresh token offered (Google without `access_type=offline`, some setups) → no check:
  Settings → Sign-in says "<label> gives no refresh token: someone disabled there stays signed in
  here until they sign out, their session ends, or you disable them on Users."
- Keycloak note (admin guide): a normal refresh token dies with Keycloak's SSO session (Session
  Idle 30 min, Max 10 h by default). The 15-minute check keeps it from going idle, but at
  Session Max the user is signed out of SelfPhoneNG too. For people who keep the softphone open all
  week, add `offline_access` to `scopes` (Keycloak then issues an offline token, Offline Session
  Idle 30 days); disabling the user in Keycloak still revokes it.

**Signing out at the provider too** (owner, 2026-10-25: yes). `POST /api/auth/logout` on an `oidc`
session, when the provider has an `end_session_endpoint`: delete our session as today, then answer
`{ ok: true, redirect }` with `buildEndSessionUrl` (`id_token_hint` from `idp_id_token_enc`,
`client_id`, `post_logout_redirect_uri = https://${PUBLIC_HOSTNAME}/login`). The web client goes
there; the provider signs out and sends the browser back to our login page. Password sessions and
providers without the endpoint: no `redirect`, as today. The session check removing a session
doesn't sign out at the provider (the provider is what said no). OIDC Back-Channel Logout: later.

### 3.6 Providers

Each row is "checked" only after a real sign-in, role mapping, the session check and signing out
pass against it (06's verify rule). The others are expected to work; the admin guide gives the same
table.

| Provider | Issuer | Groups / roles | Notes | Checked |
|---|---|---|---|---|
| Keycloak (owner) | `https://kc.example.com/realms/<realm>` | client scope with a **Group Membership** mapper → `groups` (add to ID token and userinfo), or realm roles → `realm_access.roles` (turn on "Add to userinfo": off by default) | client: OpenID Connect, Client authentication on, Standard flow only; Valid redirect URIs and Valid post logout redirect URIs from Settings; `offline_access` (§3.5) | S3 |
| Authentik | `https://auth.example.com/application/o/<slug>/` | `groups` (default profile scope) | | |
| Authelia | `https://auth.example.com` | `groups` scope → `groups` | claims mostly in userinfo (handled, §3.2 step 4); needs `offline_access` for refresh tokens | |
| Zitadel | `https://<instance>` | `urn:zitadel:iam:org:project:roles` (object → keys) | turn on "Assert roles on authentication" | |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant>/v2.0` | app roles → `roles` (group claims are GUIDs and stop at 200) | single tenant only (never `common`); no `email_verified`: see `trustEmail` | |
| Google Workspace | `https://accounts.google.com` | none | refresh tokens need `access_type=offline`: §3.5; no end-session endpoint | |
| Okta, Auth0, Kanidm, Pocket ID, Dex, GitLab, Rauthy, LemonLDAP::NG | per provider | per provider | Kanidm requires PKCE S256 and ES256 (both supported) | |

## 4. LDAP / LDAPS

Library: **ldapts** (MIT, TypeScript, maintained). Decision 0004. Its `escapeFilter` does RFC 4515
filter escaping.

The directory is one more way to check a **password**: it works in `password` and `mixed` mode for
everyone, and in `oidc` mode for admins only (§1.1).

### 4.1 Settings (`auth.ldap`)

```ts
{
  enabled: boolean,
  preset: 'ad' | 'openldap' | 'freeipa' | 'lldap' | 'other', // fills the defaults below in the form only
  url: string,                // ldaps://dc1.example.com (636) or ldap://… with startTls
  startTls: boolean,
  bindDn: string | null,      // service account; null = anonymous search
  bindPasswordEnc: string | null,
  baseDn: string,             // where people are searched (subtree)
  userFilter: string,         // must contain {login}; who may sign in
  idAttribute: string,        // stable UUID attribute
  emailAttribute: string,     // default "mail"
  nameAttribute: string,      // default "displayName", falls back to "cn"
  adminFilter: string | null, // matched against the user's own entry → admin. null = role managed here
}
```

Presets:

| Preset | `userFilter` | `idAttribute` | `adminFilter` example |
|---|---|---|---|
| Active Directory / Samba AD | `(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(\|(sAMAccountName={login})(userPrincipalName={login})(mail={login})))` | `objectGUID` (binary, read as hex) | `(memberOf:1.2.840.113556.1.4.1941:=CN=PBX Admins,OU=Groups,DC=example,DC=com)` (nested groups) |
| OpenLDAP (memberof overlay) | `(&(objectClass=inetOrgPerson)(\|(uid={login})(mail={login})))` | `entryUUID` | `(memberOf=cn=pbx-admins,ou=groups,dc=example,dc=com)` |
| FreeIPA | `(&(objectClass=person)(!(nsAccountLock=TRUE))(\|(uid={login})(mail={login})))` | `ipaUniqueID` | `(memberOf=cn=pbx-admins,cn=groups,cn=accounts,dc=example,dc=com)` |
| lldap | `(&(objectClass=person)(\|(uid={login})(mail={login})))` | `entryUUID` | `(memberOf=cn=pbx-admins,ou=groups,dc=example,dc=com)` |

To limit sign-in to one group, the admin adds `(memberOf=…)` to `userFilter`. Directories without
`memberOf` on the user (plain OpenLDAP without the overlay, `posixGroup`) can't map groups yet:
`// TODO(spec)` group search, if someone needs it (§7).

Rules, checked by `PATCH /api/settings` (400 with the reason):

- **No password in clear text over the network**: `ldap://` needs `startTls`, unless the host is
  `127.0.0.1`/`::1`/`localhost` (a directory on the same machine).
- `userFilter` contains `{login}`; `userFilter` and `adminFilter` parse as LDAP filters (ldapts).
- Timeouts are fixed: connect 5 s, each operation 5 s. Not settings.

**Test** (`POST /api/settings/auth/ldap/test`, from the unsaved form): connect, StartTLS, bind the
service account, count entries matching `userFilter` with `{login}` → `*` (at most 1,000), and with
an optional **test login** (username + password, never stored or logged): the whole §4.2 flow
without signing in, answering the DN, email, name, id, the SelfPhoneNG user it matches (or none)
and the role it would get, or the step that failed.

### 4.2 Flow (`POST /api/auth/login`)

The form field becomes **Email or username** when LDAP is on; the body is
`{ login, password, totp? }` (`email` renamed to `login`, a string of 1–254; web and API change
together, no outside client signs in with a password).

1. Rate limit as today, keyed by IP and `login`.
2. A user with email = `login` who has a password, and it's right → that user (as today).
3. Else, LDAP on → `ldapAuthenticate`:
   1. Empty password → fail **before** any bind (an LDAP simple bind with a DN and no password is
      an "unauthenticated bind" that many servers accept as anonymous success, RFC 4513 §5.1.2).
   2. Connect, StartTLS if set, bind the service account (or none).
   3. Search `baseDn`, subtree, `userFilter` with every `{login}` replaced by the escaped `login`
      (`escapeFilter`), attributes: id, email, name. Not exactly one entry → fail.
   4. Bind as that entry's DN with the password. Refused → fail.
   5. `adminFilter` set → search `base` = that DN, scope `base`, filter `adminFilter`, with the
      **service** connection: one entry → admin, none → user.
   6. Unbind and close (one connection per sign-in, no pool: a few sign-ins a day).
   Success → find the user (§4.3), copy name and role.
4. Mode check (§1.1): `oidc` mode and not an admin → 403 `password_sign_in_off`.
5. TOTP if they turned it on, then the session (`method` = `password` or `ldap`), `login` audited
   ("… signed in with the directory" for LDAP).
6. Anything else → 401 "Wrong email or password", as today (no hint whether the account exists).
   The directory unreachable → 503 `directory_unavailable` "The directory can't be reached.
   Passwords set in SelfPhoneNG still work." and a dashboard warning.

A user can have both a SelfPhoneNG password and a directory account: either password works.

### 4.3 Finding the user

1. A `user_identities` row (`ldap`, id) → its user. Their email here follows the directory's when
   it changes (unless another user has it: kept, logged).
2. Else, a user with the directory email → connect it (add the row) and sign in, audit
   `ldap_connected`. The directory is the company's own and the person just proved its password,
   so its email is trusted, unlike an OpenID provider's (§3.3).
3. Else → 401 "Wrong email or password" (no account is made, §1), with `login_failed` audited as
   "directory account … has no phone system account". The admin's Test shows the same answer.
4. No email on the entry → same 401, logged.

Users → a user shows the directory account and **Disconnect** (same rules as §3.3).

### 4.4 Ids

`objectGUID` is binary: ldapts `explicitBufferAttributes: ['objectGUID']`, stored as lowercase hex,
searched back with the Buffer through `escapeFilter` (it escapes bytes). Text ids are stored as is.

### 4.5 Leavers: `directoryCheck` (job, hourly)

For every active user with a directory account, one connection per run:

- Search `baseDn` for `(&(<idAttribute>=<id>)<userFilter with {login} → *>)`. Replacing `{login}`
  with `*` keeps every other condition of the filter (the group, AD's disabled bit, FreeIPA's lock)
  and makes the login parts presence tests.
- Found → update email, name, and role (`adminFilter`). Gone → the user is disabled
  (`is_active = false`, sessions deleted, as an admin's disable), audit `directory_disabled`
  "… is no longer in the directory". The directory account is the company's record of the person,
  so it disables the whole user, password and OpenID account included.
- The directory unreachable or the bind refused → change nothing, warn on the dashboard
  (`directory_check`). The run would disable more than half of these users (and at least 3) →
  change nothing, warn: a broken filter or base DN is likelier than a mass layoff.
- It never re-enables: an admin does that on Users (they may have disabled the person themselves).

## 5. UI (05)

- **Login** (`/login`): by mode (§1.1): the button, the form, or both; "Email or username" when
  LDAP is on; in `oidc` mode the **Admin sign-in** link; `sso_error` messages (§3.2);
  `password_sign_in_off` says "Use Sign in with <label>".
- **Sign out**: follows `redirect` when the answer has one (§3.5).
- **Settings → Sign-in** (admin, new tab): the mode (§1.1, with the `mixed` warning and the "N
  people can't sign in yet" list for `oidc`), then two cards, OpenID Connect and Directory (LDAP),
  each with the §3.1 / §4.1 fields, presets, Test, the two URIs with Copy (OIDC), the warnings of
  §3.5 and §4.5, and a link to the admin guide page.
- **Users**: a **Signs in with** column (Password, <label>, Directory: any of them); a user's
  drawer shows their connected accounts (email, groups, last used) with Disconnect; role read-only
  with "From <label>" when mapped.
- **My account → Sign-in**: password (Change password, two-step when they have a password), the
  OpenID account (**Connect <label>** / its email and **Disconnect**, in `mixed` and `oidc`), the
  directory account (read-only).

## 6. Tests

- `sso/claims.test.ts`: dotted paths (Keycloak `realm_access.roles`, `resource_access.x.roles`,
  Zitadel's `urn:…` object), allow and role decisions, `trustEmail`.
- `sso/oidc.test.ts` against a **fake provider** (`test/fake-oidc.ts`: `node:http` + `node:crypto`,
  RS256 and ES256 keys, discovery, JWKS, authorize redirect, token, userinfo, refresh, end
  session; no new dependency): a full sign-in; bad state, nonce, issuer, audience, expired token,
  wrong signature each refused; userinfo `sub` mismatch refused; §3.3 (connect, `taken`, email
  match only without a password and only verified, `not_connected`, never a new user); the three
  modes (§1.1: password refused for a user in `oidc` mode, allowed for an admin; start 404 in
  `password` mode); Disconnect's `last_way_in`; the session check removing an `oidc` session on
  `invalid_grant`, keeping it on 503 and leaving password sessions alone; logout's `redirect`; the
  callback writing no `code=` to the log.
- `sso/ldap.test.ts`: filter building (`{login}` = `*)(uid=*))(|(uid=*` is escaped; `{login}` →
  `*` for the check), empty password refused without a bind, `ldap://` to a remote host refused.
- `test/ldap-live.test.ts` against a real **lldap** container (`LDAP_LIVE_URL`, like
  `contrack-live.test.ts`): sign-in by uid and by email, connect by email, no user → refused,
  admin by `memberOf`, a removed user disabled by `directoryCheck`, LDAPS with a private CA through
  `NODE_EXTRA_CA_CERTS`. AD presets checked once against a Samba AD DC container (nested groups,
  disabled bit, `objectGUID`).
- `test/oidc-live.test.ts` against the owner's **Keycloak** (`OIDC_LIVE_ISSUER` + a test client and
  user; a headless sign-in through Keycloak's login form): connect, sign-in, group → admin, signing
  out at Keycloak, disabling the user in Keycloak ending the SelfPhoneNG session at the next check.
- `scripts/e2e/sso.mjs`: the login page per mode, the button and errors, in a browser.

## 7. Later (not in S1–S5)

- OIDC Back-Channel Logout.
- More than one OIDC provider; `private_key_jwt`.
- Setting your own password when you have none.
- LDAP group search for directories without `memberOf`; several directory URLs (failover).
- SCIM or a scheduled import of directory users (today an admin creates each user).
- Using the directory as the contacts book (11).

## 8. Order of work

| Task | What | Done when |
|---|---|---|
| S1 | Decision 0004; migration (§2); `auth.mode` (§1.1) with only `password` selectable; break glass; `GET /api/auth/methods`; the `login` field; Users "Signs in with" | `pnpm lint && typecheck && test` pass; sign-in works as before |
| S2 | OIDC: settings + Test, start/callback, claims (§3.4), §3.3 (connect, disconnect, email match), `mixed` and `oidc` modes, sign out at the provider, login page and My account, fake provider tests | every §6 OIDC case passes against the fake provider |
| S3 | OIDC session check (§3.5); Keycloak live test; admin guide page `docs/admin-guide/sign-in.md` with the §3.6 table | the owner connects their Keycloak account, signs in with it or their password, a Keycloak group makes them admin, signing out also signs out of Keycloak, and disabling them in Keycloak ends their Keycloak session here within 20 min |
| S4 | LDAP: settings + Test, presets, sign-in flow (§4.2), §4.3, unit + lldap live tests | sign-in by uid and email against lldap over LDAPS; admin by group; no user made for a stranger |
| S5 | `directoryCheck` (§4.5), dashboard warnings; Samba AD check | a user removed from the directory is disabled within an hour; AD nested-group admin works |

## 9. Decided

- Owner, 2026-10-25: a user connects their OpenID account to their account and signs in with
  either their password or OpenID; the admin picks passwords only, OpenID only, or mixed (§1.1).
- Owner, 2026-10-25: no automatic accounts, from either provider (§1).
- Owner, 2026-10-25: keep the 15-minute session check (§3.5).
- Owner, 2026-10-25: signing out also signs out at the provider (§3.5).
- Owner, 2026-10-25: password sign-ins, directory ones included, keep our two-step sign-in (§1).
- Default (not asked): in OpenID-only mode admins can still sign in with a password (break glass,
  §1.1), and pre-made users without a password are matched once by verified email (§3.3).
