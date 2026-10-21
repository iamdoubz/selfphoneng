# 06 — voip.ms trunk, numbers, SMS and E911

voip.ms is the reference provider. Everything here also has a "generic" SIP
trunk fallback (same fields, no voip.ms-specific help text or API features).

> **Verify-before-trusting rule:** voip.ms changes its portal and API over time.
> Every item marked **(verify)** must be checked against the current voip.ms
> wiki/API docs or a real packet capture during M3/M9, and this file updated.

## 1. What the customer does in the voip.ms portal (shown as a checklist in the UI)

1. **Create a sub-account** (Main Menu → Sub Accounts → Create). Use one sub-account per PBX, e.g. `123456_pbx`.
   - Authentication type: **User/Password** (or IP auth if the server has a static IP)
   - Password: strong, random
   - Device type: **Asterisk, IP PBX, Gateway or VoIP Switch** **(verify the label)**
   - Allowed codecs: **G.711u (ulaw)**. Others optional.
   - DTMF mode: **RFC 2833**
   - NAT: **Yes**
   - Encrypted SIP traffic (TLS/SRTP): optional. If on, set our trunk transport to TLS, port 5061, SRTP on. Needs Settings → Security → Accept SIP over TLS (a certificate in `data/tls`, 08 §2.1) first. voip.ms's certificate names every POP, so the trunk checks it (`verify_server`).
   - CallerID Number: your main DID.
   - International calling: leave **disabled** unless needed (toll-fraud protection on their side too).
2. **Choose a POP server** close to the PBX (e.g. `chicago1.voip.ms`). The sub-account registers to this server.
3. **Point each DID at the sub-account** (DID Numbers → Manage DIDs → edit):
   - Routing: **SIP/IAX → the sub-account**
   - **POP: the same server** the sub-account registers to. A mismatch is a common cause of inbound calls failing **(verify)**.
4. **E911**: register a street address for every DID used as an emergency caller ID (DID → e911). See §6.
5. **(Optional) API access** for SMS and DID import: Main Menu → SOAP and REST/JSON API →
   enable, set an API password, and **whitelist the PBX's public IP**.
6. **(Optional) SMS**: on each DID, enable SMS/MMS and set the SMS URL Callback (§5.2).
7. **Balance protection**: in voip.ms account settings, set low-balance alerts and
   per-call/daily limits where offered.

## 2. Trunk form (voip.ms preset)

| Field | Default | Notes |
|---|---|---|
| Name | `voip.ms` | |
| Server | dropdown | Filled from API `getServersInfo` when API creds are set; otherwise free text with examples `chicago1.voip.ms`, `atlanta1.voip.ms`, `dallas1.voip.ms`, `newyork1.voip.ms`, `losangeles1.voip.ms`, `seattle1.voip.ms`, `montreal1.voip.ms`, `toronto1.voip.ms` **(verify names)** |
| Auth mode | registration | |
| Username | | sub-account, format `^\d+_[A-Za-z0-9_]+$` or the 6-digit main account |
| Password | | |
| Transport | UDP 5060 | TLS 5061 when encryption is enabled on the sub-account |
| Codecs | ulaw | |
| Max channels | empty | |
| API username / password | empty | The API username is the account email |

The generated PJSIP config is in `03-config-generator.md` §5.3. It follows the
voip.ms Asterisk PJSIP wiki: registration + auth + aor + endpoint + identify,
`rtp_symmetric`, `rewrite_contact`, `send_rpid` and `from_user` = account.

## 3. Inbound calls: which DID was dialed?

- voip.ms's Asterisk example matches inbound calls on `exten => <10-digit DID>`,
  which means the **Request-URI user is the 10-digit DID** (no leading 1).
- The dialplan (03 §6.4) normalizes it to 11 digits and checks `sp-did-exists`. If that fails,
  it falls back to the user part of the `To:` header. That covers either behavior.
- **M3 acceptance check (verify):** run `pjsip set logger on`, call the DID from a
  mobile phone, and confirm which header carries the DID. Record the finding here.
- Inbound caller ID arrives as 10 digits for North American callers. The dialplan normalizes it to 11.

## 4. Outbound calls

- voip.ms accepts `1NXXNXXXXXX` (11 digits) and `011…` for international. Our routes always send 11 digits.
- Caller ID: we set `CALLERID(num)`, and `send_rpid=yes` sends it in `Remote-Party-ID`.
  **(verify)** whether voip.ms honors a per-call caller ID that is one of the account's DIDs, or always
  uses the sub-account's CallerID setting. If it always overrides: show a notice on the
  extension "Outbound caller ID" field ("voip.ms uses the sub-account caller ID;
  create one sub-account per caller ID if you need different ones") and, as a workaround, allow
  several trunks (one per sub-account) with routes that choose the trunk by caller.
- Toll-free and NANP routes are created by the setup wizard (03 §6.12). International is created **disabled**.

## 5. SMS / MMS

### 5.1 Sending (voip.ms REST API)
`integrations/voipms/client.ts`:
```
GET https://voip.ms/api/v1/rest.php
    ?api_username=<email>&api_password=<api pw>&method=sendSMS
    &did=<10-digit DID>&dst=<10-digit number>&message=<text>
```
- Response JSON `{"status":"success","sms":<id>}`. Any other `status` is an error code string. Store it in `sms_messages.error`.
- Messages over 160 characters: use `method=sendMMS` (`message` up to 2048 chars **(verify limit)**),
  plus `media1`…`media3` URLs for pictures. We split nothing ourselves.
- Numbers: voip.ms wants 10 digits for NANP, so strip the leading `1`.
- The API password goes in a query string, so **never log the request URL**.
- Rate limit our sends to 1 per second per DID (queue in memory).
- Other methods used: `getDIDsInfo` (DID import), `getServersInfo` (server dropdown),
  `getSMS` (optional polling fallback). All behind `voipmsApi(method, params)` with a 15 s timeout.
- `getBalance` (owner, 2026-10-21: the balance on Reports): `balance.current_balance`, a string
  like `"12.3456"` in the account's currency **(verify the shape and that the API login needs
  nothing more, with a real account)**. Each Reports load asks once per voip.ms trunk that has an
  API login.

### 5.2 Receiving
Endpoint: `GET|POST /hooks/voipms/sms/:token`. `:token` is a 32-char random value stored
in settings key `sms.webhookToken` (shown in the DID's SMS settings with a copy button).
The full URL to paste into voip.ms is shown in the UI.

voip.ms offers two callback styles **(verify both)**:
1. **URL callback (GET)** with placeholders. The UI tells the user to paste:
   `https://<host>/hooks/voipms/sms/<token>?from={FROM}&to={TO}&message={MESSAGE}&id={ID}&date={DATE}`
2. **Webhook (JSON POST)**. Accept any JSON body. Parse the known shape (look for
   `data.payload.from.phone_number`, `data.payload.to[0].phone_number`, `data.payload.text`,
   `data.payload.media[].url`, `data.payload.id`). If the shape doesn't match, store the raw body in
   the log at `warn` level (text redacted to its length) and return 200 so voip.ms doesn't retry forever.
   **M9 task:** capture one real payload into `test/fixtures/voipms/sms-webhook.json` and write the parser test from it.

Handler: normalize numbers, find the DID (404 if unknown), insert `sms_messages`
(`direction='in'`, `status='received'`), dedupe on `provider_id`, broadcast
`sms.received` to admins + `did_sms_users`, fire the webhook. Reply `ok` (text/plain, 200).
Callback IPs: voip.ms doesn't publish a fixed list **(verify)**, so security is the secret token.
Rate limit the endpoint to 60 requests/min.

## 6. Emergency calling (E911): US rules for a PBX

Legal background (summary, not legal advice; the admin guide must say "check with counsel"):
- **Kari's Law** (US, 47 CFR 9.16): users of a multi-line phone system must be able to dial
  **911 directly**, with no prefix like 9, and the system must **notify** a central location
  (front desk, security, admin) when 911 is dialed, where configured.
- **RAY BAUM'S Act** (47 CFR 9.16(b)): the 911 call must convey a **dispatchable
  location** (street address plus room/floor where needed).

How SelfPhoneNG meets this:
1. `911` and `9911` are always dialable from every extension with no restrictions (03 §6.14). Unit test:
   an extension with `outbound_class = internal`, DND on, and every trunk at max channels can still reach the 911 Dial line.
2. Notifications: email + phone ring-out + dashboard banner + webhook (04 §5.3).
3. Location: voip.ms delivers the **address registered on the DID** used as caller ID.
   - Every extension can have its own `emergency_caller_id_did_id` (a DID whose e911 address matches that person's
     location). Otherwise the system default `emergency.defaultCallerIdDidId` is used.
   - `extensions.emergency_location` (e.g. "2nd floor, room 210") is put into the notification email. The PSAP
     can't receive it through voip.ms. The admin guide must explain this limitation, and that remote
     workers need a DID with their own registered address (or must call 911 from a mobile phone).
4. Warnings: the admin dashboard shows a red banner while any trunk exists but
   `emergency.defaultCallerIdDidId` is unset, or while that DID's `e911_address` field is empty
   ("Confirm this DID has an E911 address at voip.ms").
5. **Never place a real 911 test call.** Settings → Emergency → "Test notifications" runs steps 2–4
   of 04 §5.3 with the subject prefixed `TEST` and dials nothing. (Some carriers offer a test number;
   check voip.ms docs before adding one.)
6. Canada: 911 works the same way through voip.ms. The admin guide links to voip.ms's Canadian e911 info.

## 7. DID import (`POST /api/trunks/:id/import-dids`)
Calls `getDIDsInfo`. Shows a list with checkboxes in the UI. Imported DIDs get
destination `{type:'hangup'}` and a warning chip "Not routed yet" until edited.

As built (M9-T1): `integrations/voipms/client.ts`. Assumed shapes (**verify** with a real account,
voip.ms's API docs need a login): `getServersInfo` → `servers[].server_hostname`; `getDIDsInfo` →
`dids[].did` (10 digits), `.description`, `.sms_enabled` ("1"); status `no_did` = no numbers;
`invalid_credentials`, `ip_not_enabled` get their own messages. "Import numbers from voip.ms" is in
the trunk form's API section and the setup wizard's numbers step; the label comes from the DID's
description. The server list falls back to the built-in one when the API can't be reached.
