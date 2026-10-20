# Troubleshooting

Run the commands on this page on the server, from the folder you cloned SelfPhoneNG into.

## Looking inside Asterisk

Ask Asterisk directly:

```sh
docker compose exec asterisk asterisk -rx "pjsip show registrations"   # the trunk: Registered?
docker compose exec asterisk asterisk -rx "pjsip show endpoints"       # phones and trunks
docker compose exec asterisk asterisk -rx "pjsip show contacts"        # who is signed in, from where
docker compose exec asterisk asterisk -rx "core show channels"         # calls right now
docker compose exec asterisk asterisk -rx "queue show"                 # queues and agents
```

### Seeing the SIP messages themselves

Open Asterisk's console and turn on the SIP logger:

```sh
docker compose exec asterisk asterisk -rvvv
pjsip set logger on
```

Make the failing call and read what scrolls by. To stop:

```
pjsip set logger off
exit
```

The logger prints passwords' hashes and phone numbers; don't paste it publicly without editing.

### Logs

| What | Where |
|---|---|
| Asterisk notices, warnings, errors | `data/asterisk-logs/messages.log` |
| Failed sign-ins (fail2ban reads this) | `data/asterisk-logs/security.log` |
| The api (web app, config changes, emails) | `docker compose logs api` |
| Everything, live | `docker compose logs -f` |

## One-way audio, or no audio

The call connects but one side (or both) hears nothing. It's almost always NAT
([Network](network.md#nat-a-server-behind-a-router)).

1. **SIP ALG** must be off on every router in the path. This is the first suspect.
2. **Public IP:** Settings → Network must show the server's current public IP. If it changed,
   update it and restart telephony (`docker compose restart asterisk`).
3. **Audio ports:** UDP 10000–20000 must be forwarded to the server and open on its firewall.
4. **Local networks** (setup wizard, Network step) must list your office networks, and only them.
5. **Calls drop after about 30 seconds:** same causes. The answer never reaches the other side,
   so it gives up.

## The trunk won't register

Trunks shows **Rejected** or **Not registered**.

- **Rejected:** voip.ms said no.
  - The username must be the sub-account (`123456_pbx`) and the password its password, not your
    voip.ms portal password.
  - Retype the password on the trunk and save.
- **Not registered / Unreachable:** Asterisk gets no answer.
  - Check the server name (`chicago1.voip.ms`, no `sip:` or port).
  - Check the server can reach it: `ping chicago1.voip.ms`.
  - Check outbound UDP 5060 isn't blocked by a firewall.
  - If you limited SIP to voip.ms with nftables, the POP's address may have changed
    ([Firewall](network.md#only-voipms-may-reach-sip-no-remote-phones)).
- **IP authentication:** there's nothing to register.
  - The trunk shows **Reachable** when voip.ms answers.
  - The sub-account's allowed IP must be your server's current public IP.
- **TLS:**
  - TLS must be turned on in Settings → Security, with a valid certificate.
  - Encryption must also be on at the voip.ms sub-account.
  - Port 5061.

Then run `pjsip show registrations`, and use the SIP logger to see voip.ms's answer.

## Incoming calls don't arrive

The trunk is **Registered** and outgoing calls work, but calls to your number fail or reach the
wrong place.

1. **At voip.ms** (DID Numbers → Manage DIDs), the number must be routed to **SIP/IAX → your
   sub-account**, on the **same POP** the trunk uses. A different POP is the most common cause.
2. **In SelfPhoneNG**, the number must be on **Phone numbers** with a destination. Imported numbers
   hang up until you route them.
3. **Office hours or a holiday** may be sending the call elsewhere: check the number's schedule.
4. Still nothing? Run the SIP logger, call from your mobile, and check an INVITE arrives.
   - **No INVITE:** the problem is at voip.ms or the firewall.
   - **An INVITE, then an error:** see what Asterisk replied.

## The browser phone won't connect

On **My phone**, the phone stays "connecting" or calls fail.

- **Use the address with HTTPS and the real host name.** Browsers block the microphone on plain
  HTTP or an IP address.
- **Microphone permission:** the browser must be allowed to use it. Look for the camera/mic icon
  in the address bar.
- **The reverse proxy must pass `/ws`** to `127.0.0.1:8088` with WebSocket upgrades.
  - The bundled Caddy and `deploy/nginx/selfphoneng.conf.example` both do.
  - On your own proxy, check: `curl -i https://pbx.example.com/ws` should answer
    `426 Upgrade Required` with `Server: Asterisk`, not 404 or the web app.
- **Certificate:** the browser must trust the HTTPS certificate (no warning page).
- **No audio on browser calls:** see [one-way audio](#one-way-audio-or-no-audio). Browsers use the
  same audio ports.

## Voicemail emails (or alerts) aren't sent

1. **Settings → Email → Send test** to your own address. The error shown says what the mail server
   answered.
2. Check the server, port and security setting match your provider:
   - 587 with STARTTLS;
   - or 465 with TLS from the start.
   Many providers need an app password.
3. The user's email address must be right, and voicemail-to-email on for them.
4. The api's log has every send error: `docker compose logs api | grep -i mail`.

## "SIP port or transport changes need a telephony restart"

Changes to the public IP, SIP ports or TLS only take effect when Asterisk restarts. Run this when
nobody is on a call:

```sh
docker compose restart asterisk
```

The admin page **System** shows the same command. It says "Restart: Not needed" and the banner
goes away a few seconds after Asterisk is back.

## Locked out

- **Forgot the admin password:** another admin can reset it on **Users & Extensions**.
- **Lost the phone with the two-step codes:** use a recovery code, or have another admin turn
  two-step sign-in off for you (Users & Extensions → the user → turn off two-step sign-in).
- **The only admin is locked out:** keep two admins so this can't happen. If it does, the api
  makes a new admin from `.env` when no admin is left:
  1. Make the locked-out account a plain user:

     ```sh
     docker compose exec postgres psql -U selfphoneng \
       -c "update users set role = 'user' where email = 'you@example.com'"
     ```

  2. In `.env`, set `INITIAL_ADMIN_EMAIL` to an email **no account uses yet** and
     `INITIAL_ADMIN_PASSWORD` to a temporary password.
  3. Run `docker compose up -d --force-recreate api`.
  4. Sign in with the new email; you're asked to change the password.
  5. On **Users & Extensions**, make your old account an admin again, reset its password (and
     two-step sign-in), sign in with it, and delete the temporary admin.
