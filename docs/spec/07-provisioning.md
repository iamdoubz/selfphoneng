# 07 — Phone provisioning (desk phones, softphones, mobile)

## 1. How it works

1. Admin adds a device: MAC + vendor + model + extension (`/admin/devices`).
   The api generates `provisioning_password` (20 chars).
2. The phone learns the provisioning URL in one of three ways: DHCP option 66
   (`https://pbx.example.com/prov/`), typed into the phone's web UI, or the vendor's redirect service
   (not supported in v1).
3. The phone requests its file over HTTPS with HTTP Basic auth:
   username = MAC (12 lowercase hex), password = provisioning password.
4. The api renders the file from the vendor template with that extension's data.

Code: `apps/api/src/provisioning/`. Templates are TypeScript functions
(`templates/yealink.ts`, `templates/grandstream.ts`, `templates/polycom.ts`) that take a
`ProvisionContext` and return a string. No template engine dependency.

```ts
type ProvisionContext = {
  mac: string; vendor: string; model?: string;
  host: string;                    // PUBLIC_HOSTNAME
  sipPort: number; transport: 'udp'|'tcp'|'tls';
  ext: { number: string; name: string; sipPassword: string; voicemailNumber: '*97' };
  blf: { number: string; label: string }[];      // from extensions.blf_numbers
  timezone: { iana: string; yealinkOffset: string; yealinkName: string; posix: string };
  provUrl: string; provUser: string; provPassword: string;
  phonebookUrl: string;
  ntpServer: string;               // default 'pool.ntp.org'
};
```

## 2. Endpoints (`routes/provisioning.ts`, no session auth)

| Path | Vendor | Notes |
|---|---|---|
| `GET /prov/<mac>.cfg` | Yealink (also Polycom master, see §3.3) | MAC lowercase. Decide by `devices.vendor` |
| `GET /prov/y0000000000<xx>.cfg` | Yealink common file | Return an empty valid file `#!version:1.0.0.1\n` |
| `GET /prov/cfg<mac>.xml` | Grandstream | |
| `GET /prov/phonebook/<mac>.xml` | both | company phonebook + extensions, vendor-specific XML |
| `GET /prov/linphone/<token>.xml` | Linphone (§5) | token auth instead of Basic |

Rules:
- Unknown MAC → 404, wrong/missing Basic auth → 401 with `WWW-Authenticate: Basic realm="selfphoneng"`.
  Both get logged with IP. Rate limit: 20 requests / 10 min per IP; after 10 failures, block that IP for 1 h.
- If `provisioning.lanOnly` is true and the client IP isn't in `network.localNets` → 403.
- On success: update `last_provisioned_at`, `last_provisioned_ip`. Set `Cache-Control: no-store`.
- Never serve over plain HTTP. The reverse proxy only listens on 443. (Old phones that can't do modern TLS are not supported.)

## 3. Templates

The key names below come from vendor documentation. Each one is marked
**(verify per model)**. Before marking M10 done, test on at least one real
Yealink and one Grandstream phone, or the vendor's config validator.

### 3.1 Yealink (T3x/T4x/T5x)

```
#!version:1.0.0.1
## account 1
account.1.enable = 1
account.1.label = {ext.number} {ext.name}
account.1.display_name = {ext.name}
account.1.auth_name = {ext.number}
account.1.user_name = {ext.number}
account.1.password = {ext.sipPassword}
account.1.sip_server.1.address = {host}
account.1.sip_server.1.port = {sipPort}
account.1.sip_server.1.transport_type = {0 udp | 1 tcp | 2 tls}
account.1.sip_server.1.expires = 300
account.1.dtmf.type = 1
account.1.subscribe_mwi_to_vm = 1
voice_mail.number.1 = *97
features.pickup.direct_pickup_enable = 1
features.pickup.direct_pickup_code = **
features.pickup.group_pickup_enable = 1
features.pickup.group_pickup_code = *8
## BLF keys (start at linekey 2; linekey 1 is the line)
linekey.{n}.type = 16
linekey.{n}.line = 1
linekey.{n}.value = {blf.number}
linekey.{n}.label = {blf.label}
linekey.{n}.pickup_value = **{blf.number}
## time
local_time.time_zone = {timezone.yealinkOffset}
local_time.time_zone_name = {timezone.yealinkName}
local_time.ntp_server1 = {ntpServer}
## phonebook
remote_phonebook.data.1.url = {phonebookUrl}
remote_phonebook.data.1.name = Company
## keep provisioning
static.auto_provision.server.url = {provUrl}
static.auto_provision.server.username = {provUser}
static.auto_provision.server.password = {provPassword}
static.auto_provision.repeat.enable = 1
static.auto_provision.repeat.minutes = 1440
```
Phonebook XML:
```xml
<YealinkIPPhoneDirectory>
  <DirectoryEntry><Name>Dan Doe</Name><Telephone>101</Telephone></DirectoryEntry>
</YealinkIPPhoneDirectory>
```

### 3.2 Grandstream (GRP/GXP)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gs_provision version="1">
  <mac>{mac}</mac>
  <config version="1">
    <P271>1</P271>                     <!-- account 1 active -->
    <P270>{ext.number} {ext.name}</P270> <!-- account name -->
    <P47>{host}:{sipPort}</P47>        <!-- SIP server -->
    <P35>{ext.number}</P35>            <!-- SIP user ID -->
    <P36>{ext.number}</P36>            <!-- auth ID -->
    <P34>{ext.sipPassword}</P34>       <!-- password -->
    <P3>{ext.name}</P3>                <!-- display name -->
    <P33>*97</P33>                     <!-- voicemail -->
    <P130>{0 udp | 1 tcp | 2 tls}</P130>
    <P212>2</P212>                     <!-- config upgrade via HTTPS -->
    <P237>{host}/prov</P237>           <!-- config server path -->
    <P1360>{provUser}</P1360>          <!-- HTTP(S) username -->
    <P1361>{provPassword}</P1361>      <!-- HTTP(S) password -->
    <P30>{ntpServer}</P30>
    <P64>{timezone.posix}</P64>
  </config>
</gs_provision>
```
All P-values are **(verify per model)**. BLF/MPK keys on Grandstream differ by
model family, so they are **left out of v1**. Show a note in the UI.
All XML values must be XML-escaped.

### 3.3 Polycom (VVX)
Stretch goal for M10. Serve `<mac>.cfg` as a master config whose `CONFIG_FILES`
points to `phone-<mac>.cfg` with `reg.1.address`, `reg.1.auth.userId`,
`reg.1.auth.password`, `reg.1.server.1.address`, `msg.mwi.1.subscribe`. Mark as experimental.

### 3.4 Timezone mapping
`provisioning/timezones.ts`: a table for at least the US/Canada zones (Eastern, Central,
Mountain, Arizona, Pacific, Alaska, Hawaii, Atlantic, Newfoundland) plus UTC and London,
mapping IANA → Yealink offset/name → POSIX TZ string. Anything else falls back to UTC with a UI warning.

## 4. Generic devices
Vendor `generic`: no file is served. The device page shows manual settings instead:
server, port, transport, username, password (reveal), voicemail `*97`.

## 5. Softphone apps (desktop + mobile)

Recommended open source apps (put in the user's "Set up a phone app" page):
- **Linphone** (Android, iOS, Windows, macOS, Linux; GPL). Supports remote provisioning via QR code.
- **MicroSIP** (Windows; GPL). Manual setup.
- **Baresip** (Linux, CLI; BSD). Manual setup, also used in our tests.

Linphone provisioning:
- `GET /api/extensions/:id/softphone-qr` (admin) or `GET /api/me/softphone-qr` returns a PNG QR (via
  `qrcode`) of `https://<host>/prov/linphone/<token>.xml`.
- `token` = base64url(`extensionId` + `.` + `expiryUnix` + `.` + HMAC-SHA256(APP_SECRET, extensionId + expiry)), valid 24 h.
  It is stateless, so there's no table. Regenerating the SIP password makes old configs useless anyway.
- XML:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<config xmlns="http://www.linphone.org/xsds/lpconfig.xsd">
  <section name="proxy_0">
    <entry name="reg_proxy">&lt;sip:{host}:{sipPort};transport={udp|tcp|tls}&gt;</entry>
    <entry name="reg_identity">"{name}" &lt;sip:{ext}@{host}&gt;</entry>
    <entry name="reg_expires">600</entry>
    <entry name="reg_sendregister">1</entry>
  </section>
  <section name="auth_info_0">
    <entry name="username">{ext}</entry>
    <entry name="passwd">{sipPassword}</entry>
    <entry name="domain">{host}</entry>
  </section>
</config>
```
**(verify against Linphone's remote provisioning docs)**

Mobile limitation (state it plainly in the UI and admin guide): without push
notifications, iOS and battery-optimized Android apps miss calls while in the
background. A push gateway is a v2 item. For v1, recommend the desk phone + browser softphone,
or call forwarding to a mobile number (CFNA) as the fallback.
