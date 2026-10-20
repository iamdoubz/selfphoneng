# Updating, backups and monitoring

## Updating SelfPhoneNG

SelfPhoneNG has no releases yet. How to update will be documented, with a tested update
script, when version 1.0 ships.

### Asterisk security releases

SelfPhoneNG builds Asterisk from source, checking the download against Asterisk's published
checksum. New Asterisk versions come with SelfPhoneNG updates.

To take an Asterisk fix before that, build the version you need yourself. Release numbers are
listed at <https://downloads.asterisk.org/pub/telephony/asterisk/releases/>.

```sh
docker compose build --build-arg ASTERISK_VERSION=24.0.1 asterisk
docker compose up -d asterisk
docker compose exec asterisk asterisk -rx "core show version"
```

A later rebuild without `--build-arg` goes back to the version the code names.

## Backups

**Settings → Backups:**

- **Back up every day** at a time you choose, keeping the newest few.
- **Back up now** makes one right away.
- The list downloads any of them.

![Settings → Backups](img/settings-backups.png)

A backup (`data/backups/selfphoneng-YYYYMMDD-HHMM.tar.gz`) holds:

- the database: users, extensions, numbers, settings, call history;
- voicemail;
- your sounds and music on hold;
- call recordings, if you tick **"Include call recordings"** (they can be large).

If a daily backup fails, the admins get an email, and the dashboard warns while today's backup is
missing.

**Two things a backup doesn't hold:**

1. **`.env`.** Its `APP_SECRET` encrypts the SIP and trunk passwords inside the backup.
   - **A backup can only be restored with the `.env` it was made with**, so keep a copy of `.env`
     in a password manager.
   - The backup itself holds no plain passwords.
2. **A copy anywhere else.** Backups sit on the same disk as the system. Copy them off the server
   regularly, e.g. with a nightly cron job:
   `rsync -a /opt/selfphoneng/data/backups/ backup-host:selfphoneng/`.

## Restoring

```sh
./scripts/restore.sh /path/to/selfphoneng-20261019-0300.tar.gz
```

The script:

- refuses if `.env`'s `APP_SECRET` isn't the one the backup was made with;
- shows what the backup holds and asks you to type `yes`;
- replaces the database and those folders, then starts everything again.

Asterisk's config is rebuilt from the restored database. Sign in with the passwords from the
backup.

### Moving to a new server

1. Clone SelfPhoneNG on the new server.
2. **Copy your old `.env`** into the folder.
3. Run `./scripts/install.sh`. It keeps the existing `.env`.
4. Run `./scripts/restore.sh <backup>`.
5. If the public IP changed: update it on **Settings → Network**, change your DNS record and any
   IP-based settings at voip.ms (IP authentication, API whitelist), then
   `docker compose restart asterisk`.
6. Desk phones fetch their setup from the host name, so they follow the DNS change.

## Monitoring

**Emails to admins.** SelfPhoneNG emails every admin when:

- a trunk has been down for 5 minutes (one email per outage);
- the disk is under 10% free (once a day);
- the public IP changed (with the re-check turned on);
- a daily backup failed.

These need **Settings → Email** working.

**Health check** for an uptime monitor (Uptime Kuma or similar), on the server itself:

```sh
curl http://127.0.0.1:8080/healthz      # 200 {"ok":true}, or 503 when the database is down
```

From outside, monitor `https://pbx.example.com/healthz`.

**The dashboard** shows trunks, active calls, queues and warnings (emergency setup, certificate,
backups, restart needed) live.

### Keeping logs small

Asterisk's log files in `data/asterisk-logs/` grow forever. Rotate them with logrotate. Create
`/etc/logrotate.d/selfphoneng`:

```
/opt/selfphoneng/data/asterisk-logs/*.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

`copytruncate` lets Asterisk keep writing to the same file. fail2ban and CrowdSec notice the file
shrinking.

The api's logs are Docker's. Limit them in `/etc/docker/daemon.json` with
`"log-opts": {"max-size": "20m", "max-file": "5"}`, restart Docker, then
`docker compose up -d --force-recreate` (the limit only applies to new containers).
