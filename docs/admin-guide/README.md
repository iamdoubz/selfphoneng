# SelfPhoneNG admin guide

This guide takes you from an empty server to working inbound and outbound calls, then covers
keeping the system safe, legal and up to date.

1. **Install** (this page)
2. [voip.ms setup](voipms.md): the sub-account, numbers and the trunk
3. [Network, firewall and attacks](network.md): NAT, SIP ALG, ports, firewall, fail2ban / CrowdSec
4. [Emergency calls and recording law](legal.md): E911 duties and call recording consent
5. [Troubleshooting](troubleshooting.md)
6. [Updating, backups and monitoring](maintenance.md)
7. [Analog phones (ATAs)](ata.md)
8. [Local AI](ai.md): voicemail transcripts

---

## What you need

- A Linux server (a VM is fine) with a **public IP** or a router you can forward ports on.
  A small office needs very little: 1–2 CPUs and 2 GB of memory is plenty.
- **Docker Engine with the compose plugin**: <https://docs.docker.com/engine/install/>.
  Check with `docker compose version`.
- `git` and `openssl` (both are on almost every Linux install).
- A **DNS name** for the server, e.g. `pbx.example.com`, with an A record pointing at its public IP.
  Browsers need HTTPS for the microphone, so the browser phone only works through this name.
- A **voip.ms account** with at least one phone number (DID). Other SIP providers work as a
  "generic" trunk, but this guide uses voip.ms.

## Ports

Open these to the internet (on the server's firewall, and forwarded on your router if the
server is behind one; see [Network](network.md)):

| Port | Protocol | For |
|---|---|---|
| 443 | TCP | Web app, browser phone, phone setup files |
| 80 | TCP | Only with the bundled Caddy: getting the HTTPS certificate |
| 5060 | UDP (+TCP) | SIP: voip.ms and desk phones |
| 5061 | TCP | Only if you turn on SIP over TLS |
| 10000–20000 | UDP | Call audio (RTP); another range with `RTP_PORT_START`/`RTP_PORT_END` ([Network](network.md#call-audio-ports)) |

Everything else (the database, the api on 8080, Asterisk's 5038 and 8088) listens on
127.0.0.1 only. Don't open them.

## Install

```sh
git clone https://git.dou.bet/spng/selfphoneng.git
cd selfphoneng
./scripts/install.sh
```

The script:

1. Checks Docker is there.
2. Writes `.env` with random passwords and asks for:
   - the **public host name** (`pbx.example.com`),
   - the **first admin's email and password** (at least 10 characters).
3. Makes the `data/` folders.
4. Asks **"Use bundled Caddy for HTTPS?"**
   - **Yes**: Caddy gets a Let's Encrypt certificate for your host name by itself. Ports 80 and
     443 must reach the server and nothing else may use them.
   - **No**: you already run a reverse proxy. Copy `deploy/nginx/selfphoneng.conf.example`,
     put in your host name and certificate paths, and reload nginx. Any proxy works if it sends
     `/ws` to `127.0.0.1:8088` (the browser phone's WebSocket) and everything else to
     `127.0.0.1:8080`, with WebSocket upgrades allowed on both.
5. Builds and starts everything. The first build compiles Asterisk, so it takes a while.

When it's done, check the health URL on the server:

```sh
curl http://127.0.0.1:8080/healthz      # {"ok":true}
```

> **Keep `.env` safe and never change `APP_SECRET`.** It encrypts the SIP and trunk passwords in
> the database, and backups can only be restored with it. Copy `.env` somewhere safe (a password
> manager) now.

## First sign-in: the setup wizard

Open `https://pbx.example.com/` and sign in with the admin email and password you gave the
script. You're asked to pick a new password, then the setup wizard walks you through:

| Step | What to do |
|---|---|
| Company | Name and time zone (office hours and reports use it). |
| Network | The **public IP** (Detect fills it in) and the **local networks**. Do the router steps shown there: SIP ALG off and the port forwards ([Network](network.md)). |
| Email | Your SMTP server, then **Send test**. Voicemail-to-email and alerts need it. |
| Trunk | Your voip.ms sub-account ([voip.ms setup](voipms.md)). Wait for **Registered**. |
| Phone numbers | Add your DIDs, or **Import numbers from voip.ms** if you gave API details. |
| Users | People and their extensions. |
| Main number | Where calls to your main number go. |
| Emergency | The **default emergency caller ID** (required once a trunk exists) and who's told when someone dials 911 ([E911](legal.md#emergency-calls-e911)). |

You can leave the wizard and come back; everything it sets is also in the admin pages.

Then:

- **Place a test call out.** From a desk phone, or from the browser phone (a user with an
  extension signs in and calls from **My phone**), call your mobile.
- **Place a test call in.** From your mobile, call your main number.

If either fails, see [Troubleshooting](troubleshooting.md).

## Phones

- **Desk phones (Yealink, Grandstream, Polycom/Poly, Snom, Fanvil):** add them on **Phones** with
  their MAC address. The page shows the setup URL and password to enter on the phone.
- **Any other SIP phone:** use the details on the user's **Credentials** tab.
- **Browser phone:** every user with an extension gets one on **My phone** after signing in. There
  is nothing to set up.

## Turning on two-step sign-in

Admins can (and should) turn on two-step sign-in: header → **Account** → **Turn on two-step sign-in**. Keep
the recovery codes somewhere safe.
