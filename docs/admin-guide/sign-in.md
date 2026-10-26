# Sign-in: passwords, OpenID Connect and LDAP

People sign in to SelfPhoneNG (the admin pages, their own portal and the browser phone) with a
password, with your company's identity provider through **OpenID Connect**, or either. This only
changes the web sign-in: desk phones, phone apps and the browser phone's line keep their own SIP
passwords and never talk to the identity provider.

Any provider that speaks OpenID Connect works. This page uses **Keycloak**; the table at the end
says what is different for the others. A company directory (Active Directory, OpenLDAP, FreeIPA,
lldap …) can check passwords too: see [Directory (LDAP)](#directory-ldap).

## How it works

- You still make every user on **Users**. Signing in with the provider never creates an account.
- Each person **connects** their provider account once, in **My settings** (users) or **My
  account** (admins): **Connect Keycloak**, sign in at Keycloak, done. From then on they sign in
  with **Sign in with Keycloak** or with their password.
- **Settings → Sign-in → How people sign in** picks what the login page offers:

  | Choice | Login page | Who can use a password |
  |---|---|---|
  | Passwords | the password form | everyone |
  | Passwords or OpenID | the button and the form | everyone |
  | OpenID only | the button, and a small **Admin sign-in** link | admins only |

  Admins keep their password in every mode so you can still get in when the provider is down.
  SelfPhoneNG also won't let you delete, disable or demote the last admin who has a password.
- Someone disabled in Keycloak loses their Keycloak sign-in to SelfPhoneNG within about 20
  minutes: every 15 minutes SelfPhoneNG asks Keycloak whether each Keycloak session is still good.
  With **Passwords or OpenID**, their SelfPhoneNG password still works until you disable them on
  Users too. With **OpenID only**, Keycloak alone decides.
- **Sign out** in SelfPhoneNG also signs out of Keycloak, when the session came from Keycloak.
- Two-step sign-in (the authenticator app code) is asked for password sign-ins only. Keycloak
  sign-ins use whatever Keycloak asks for (set up OTP or passkeys there).

## 1. In Keycloak

1. Pick the realm your people are in (or make one). The **issuer** is
   `https://<keycloak>/realms/<realm>`.
2. **Clients → Create client**:
   - Client type **OpenID Connect**, Client ID `selfphoneng`.
   - **Client authentication: On**. Authentication flow: **Standard flow** only (turn off Direct
     access grants).
   - **Valid redirect URIs**: `https://pbx.example.com/api/auth/oidc/callback`
   - **Valid post logout redirect URIs**: `https://pbx.example.com/login`

   (Use your own host name. Settings → Sign-in shows both with Copy buttons.)
3. **Credentials** tab of the client: copy the **Client secret**.
4. To make admins from a group (optional): **Groups → Create group** `pbx-admins` and put your
   admins in it. Then the client's **Client scopes** tab → `selfphoneng-dedicated` → **Add mapper →
   By configuration → Group Membership**: name `groups`, Token Claim Name `groups`, **Full group
   path off**, and **Add to ID token**, **Add to access token** and **Add to userinfo** on.
5. People who keep the browser phone open all week: Keycloak ends a normal session after 10 hours
   (Realm settings → Sessions → SSO Session Max), and SelfPhoneNG signs them out then too. To keep
   them signed in, add `offline_access` to the Scopes in step 2 below. Disabling the user in
   Keycloak still signs them out.

## 2. In SelfPhoneNG

**Settings → Sign-in**:

1. **Issuer** `https://keycloak.example.com/realms/company`, **Client ID** `selfphoneng`,
   **Client secret** from step 1.3. **Button name** `Keycloak` (shown as "Sign in with Keycloak").
2. **Scopes** `openid email profile` (add `offline_access`, see 1.5).
3. **Admin groups** `pbx-admins` if you did step 1.4: members become admins at each sign-in, and
   everyone else becomes a user. Leave it empty to set roles on Users yourself.
   **Allowed groups**: leave empty, or name the groups whose members may sign in.
4. **Test**. It should say "Works", with refresh tokens and "signs out there too".
5. Pick **Passwords or OpenID** and **Save**.
6. **My account → Connect Keycloak**, then sign in from a private window with **Sign in with
   Keycloak**. If a group should have made you admin and didn't, Users → your user shows the
   groups Keycloak sent: type them exactly like that.

Once everyone has connected (Users shows "Signs in with" for each person), you can switch to
**OpenID only**. People you add from then on get no password: they sign in with Keycloak, and
SelfPhoneNG matches them by their **verified** email the first time.

### Keycloak with a self-signed or private certificate

Put the CA certificate (PEM) in `data/tls/idp-ca.pem`, add this to `.env`, and restart the api
(`docker compose up -d api`):

```dotenv
NODE_EXTRA_CA_CERTS=/var/lib/selfphoneng/tls/idp-ca.pem
```

There is no "don't check the certificate" switch.

## When it doesn't work

The login page says what went wrong in plain words. The reason Keycloak gave is in the api's log:
`docker compose logs api | grep "OpenID sign-in failed"` (the `reason` field).

| Message | Fix |
|---|---|
| "…isn't connected to a phone system account" | They sign in with their password and **Connect Keycloak** first. Or: their SelfPhoneNG user has no password and Keycloak's email for them isn't verified (Keycloak → Users → the user → Email verified). |
| "…already connected to another user" | Someone else connected that Keycloak account. Disconnect it on Users → that user. |
| "…isn't allowed to use the phone system" | Not in **Allowed groups**. |
| "…sign-in didn't work" with `invalid_client` | Client ID or secret wrong, or Client authentication off. |
| …with `redirect_uri` | The Valid redirect URI in Keycloak doesn't match exactly (https, host, path). |
| …with an issuer mismatch | The issuer must be exactly what Keycloak's `/.well-known/openid-configuration` says, including `/realms/<realm>`. |
| Test: "fetch failed" / certificate errors | The server can't reach Keycloak, or doesn't trust its certificate (see above). |
| Signed out after 10 hours | Add `offline_access` to Scopes (1.5). |

## Other providers

| Provider | Issuer | Groups claim | Notes |
|---|---|---|---|
| Authentik | `https://auth.example.com/application/o/<slug>/` (keep the last `/`) | `groups` | |
| Authelia | `https://auth.example.com` | `groups` (add the `groups` scope) | add `offline_access` for the 15-minute check |
| Zitadel | `https://<instance>` | `urn:zitadel:iam:org:project:roles` | turn on "Assert roles on authentication" |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant id>/v2.0` | `roles` (use app roles; group claims are IDs) | Entra doesn't send "email verified": turn on **Trust email addresses** only for your own single tenant |
| Google Workspace | `https://accounts.google.com` | none | no sign-out endpoint and no refresh tokens by default: people disabled in Google stay signed in until they sign out or you disable them on Users |
| Okta, Auth0, Kanidm, Pocket ID, Dex, GitLab, Rauthy | as the provider documents | as the provider documents | expected to work, not tested yet |

Keycloak (26.8.1) is the one SelfPhoneNG is tested against.

## Directory (LDAP)

With a directory, people sign in with their **directory username or email and password**. When
the password isn't the one set in SelfPhoneNG, SelfPhoneNG asks the directory. The first time,
they're matched to their user here by the directory's email; nobody gets a user just for being in
the directory. Their SelfPhoneNG password, if they have one, keeps working too.

**Settings → Sign-in → Directory (LDAP)**:

1. **Directory type**: Active Directory, OpenLDAP, FreeIPA or lldap. It fills in the filters.
2. **Address**: `ldaps://dc1.example.com` (port 636), or `ldap://…` with **StartTLS**. A plain
   `ldap://` address is refused unless the directory runs on this same server, because passwords
   would cross the network in clear text. For a private CA, see
   [the certificate section](#keycloak-with-a-self-signed-or-private-certificate) (same file).
3. **Service account DN** and **password**: an account that may search people, e.g.
   `CN=pbx-search,OU=Service,DC=example,DC=com`. Empty searches anonymously.
4. **Where people are**: the base DN, e.g. `DC=example,DC=com` or `ou=people,dc=example,dc=com`.
5. **User filter**: `{login}` is what they type. Only one group may sign in? Add
   `(memberOf=CN=Phone users,OU=Groups,DC=example,DC=com)` inside the `(&…)`.
6. **Admin filter**: people it matches are admins at each sign-in, the others users, e.g.
   `(memberOf=cn=pbx-admins,ou=groups,dc=example,dc=com)`. Active Directory's preset uses
   `memberOf:1.2.840.113556.1.4.1941:=` so nested groups count. Empty: you set roles on Users.
7. **Test**, with a test login and its password: it says how many people the filter matches, and
   who that login would sign in as here.
8. Tick **Check passwords against the directory** and **Save**.

### Leavers

Every hour, SelfPhoneNG looks up each user who has signed in with the directory. Someone deleted
from it, disabled there (Active Directory's disabled bit, FreeIPA's lock) or no longer matched by
the user filter (removed from the group you added to it) is **disabled here**: their password and
OpenID sign-in stop working too, and they're signed out. The role follows the admin filter in the
same run. Nobody is enabled again automatically: do that on **Users**.

If a run would disable more than half of these people (and at least 3), it disables nobody and
the dashboard says so: a wrong base DN or filter is likelier than everyone leaving. The last admin
who has a password is never disabled.

If the directory is down, people get "The directory can't be reached", passwords set in
SelfPhoneNG still work, and the dashboard shows a warning until the next hourly check reaches it.
Directories without `memberOf` on people (OpenLDAP without the memberof overlay) can't map groups
yet. Tested against lldap 0.6.3 and Samba 4 Active Directory (nested groups, the disabled bit).
