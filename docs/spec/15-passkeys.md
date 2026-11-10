# 15 — Passkeys

Owner, 2026-11-10: people can sign in to the web app with a passkey (WebAuthn): the device's
fingerprint, face or PIN, or a security key. Like the other ways in 12, it is one more way to sign
in to the same account; it replaces none.

## 1. Rules

- **Everyone** with a password here can add passkeys (up to 10), on My account (admins) and My
  settings (users), in the Sign-in card.
- **Adding one asks for the password again**, like turning two-step sign-in on (08 §2.4): a stolen
  session alone can't add its own way back in. So a user with no password (made in OpenID-only
  mode, 12 §2) has no passkeys: their provider is their sign-in.
- **A passkey is both steps.** We require user verification (the device checked the person), so
  a passkey sign-in never asks for the TOTP code, and counts as two-step for
  `auth.requireAdminTotp` when that is built (08 §8.2: exempt like OpenID sessions).
- **No email typed**: passkeys are discoverable (stored on the device with the account), so the
  login page has one button and the public routes say nothing about any user.
- **Sign-in mode** (12 §1.1): a passkey follows the password. `password` and `mixed`: everyone.
  `oidc`: admins only, everyone else 403 `password_sign_in_off`.
- **Removing** one needs no password (it takes a way in away, it doesn't add one). An admin's
  **Reset password** removes the user's passkeys too: a reset is for an account someone else may
  have got into. Changing your own password keeps them; the list is on the same page.
- Disabled users can't sign in with one. Deleting a user deletes theirs (cascade).
- A session made with a passkey has `sessions.method = 'passkey'`. Like OpenID sessions it isn't
  held by `must_change_password` (that guards the password).
- Passkeys are tied to the site's name: they work on `https://<PUBLIC_HOSTNAME>` only. Not on
  `localhost` through the SSH tunnel (08 §8.2); the password works there.
- Not for the mobile app (it pairs, 13 §2), API tokens or phones.

## 2. Data (migration 0016)

```sql
create table passkeys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  credential_id text not null unique,     -- base64url, as the browser names it
  public_key    text not null,            -- SPKI DER, base64
  alg           integer not null,         -- COSE: -7 ES256, -8 EdDSA, -257 RS256
  sign_count    bigint not null default 0,
  name          text not null,            -- the person's name for it ("Work laptop")
  last_used_at  timestamptz,
  created_at, updated_at
);
create index on passkeys (user_id);
-- sessions.method also allows 'passkey'
```

Only public keys are stored: nothing here signs in if the database leaks.

## 3. Checks (`auth/passkeys.ts`, node:crypto only)

No dependency (AGENTS rule 3), as with TOTP. We ask for no attestation (`attestation: 'none'`:
we don't care which brand of device it is), so there is no CBOR to read: the browser gives the
public key (`getPublicKey()`, SPKI) and the authenticator data (`getAuthenticatorData()`).

- **Challenge**: 32 random bytes, kept in memory 5 minutes, used once, and made either for one
  user (adding) or for no one (signing in); one kind can't be used as the other. At most 10 000
  wait at a time, the oldest dropped first. In memory like the login limiter: one api process.
- **Client data**: `type` (`webauthn.create` / `webauthn.get`), `origin` =
  `https://<PUBLIC_HOSTNAME>`, not cross-origin, and the challenge.
- **Authenticator data**: the first 32 bytes are sha256 of the site id (`PUBLIC_HOSTNAME` without
  a port); flags must have user present and **user verified**.
- **Adding**: the credential id inside the authenticator data must be the id sent; the key must
  be the kind its algorithm says (P-256, Ed25519, or RSA of 2048 bits or more).
- **Signing in**: the signature over `authenticatorData || sha256(clientDataJSON)` with the
  stored key. The counter: synced passkeys always say 0; one that counts must go up, or the
  sign-in is refused (a copied key).

## 4. API (`routes/auth.ts`)

| Route | Who | What |
|---|---|---|
| `GET /api/auth/passkeys` | signed in | `{ items: [{ id, name, createdAt, lastUsedAt }] }` |
| `POST /api/auth/passkeys/options` | signed in | `PasskeyCreateOptions`: challenge, site, user, algorithms, the ids already added |
| `POST /api/auth/passkeys` | signed in | `PasskeyAddSchema` (name, password, the new passkey). 400 wrong password (counted by the login limiter) or a failed check; 409 already added, or 10 already |
| `DELETE /api/auth/passkeys/:id` | signed in | your own only (404 otherwise) |
| `POST /api/auth/passkey/options` | public | `{ challenge, rpId }`, the same for everyone |
| `POST /api/auth/passkey/login` | public | `PasskeyLoginSchema` → the session cookie and `{ user }`, like `/api/auth/login`. 401 for every failure (unknown passkey, failed check, disabled user), counted per address by the login limiter (04 §2.2), 429 when blocked |

Audit: `create` / `delete` (`passkey`), `login` ("logged in with the passkey …"), `login_failed`.
Why a check failed goes to the log (`auth.passkey`, `auth.failed`), never to the browser.

## 5. UI

- Login page: **Sign in with a passkey** under the password form's button, when the browser has
  WebAuthn. In `oidc` mode it sits with the form behind "Admin sign-in".
- Sign-in card (`components/SignInCard.tsx`): **Passkeys**: the list (name, added, last used,
  Remove) and **Add a passkey** (a name and the password, then the device's own prompt).
  Browser code: `apps/web/src/auth/passkey.ts`.

## 6. Tests

- `auth/passkeys.test.ts`: all three algorithms; a challenge once, in time, for whom it was made;
  wrong origin, wrong site, no user verification, wrong signature, wrong key kind, counter back,
  credential id mismatch. The authenticator is `test/fake-passkey.ts` (node:crypto).
- `test/passkeys.test.ts`: add (password needed, once), list, sign in (session method, counter,
  audit), replay, unknown, other origin, disabled, the limiter, `oidc` mode, remove (own only),
  Reset password removes.

## 7. Open

- Not tried in a real browser or with a real device yet (owner): Chrome, Firefox and Safari; a
  phone's passkey, Windows Hello, and a security key.
- Later, if wanted: an admin removing one user's passkeys without a reset (Users); a note in the
  admin guide for sharing a passkey between devices (the password manager's job).
