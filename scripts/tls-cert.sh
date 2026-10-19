#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Puts the SIP TLS certificate in data/tls and makes Asterisk use it (M11-T2). Asterisk re-reads
# the files on a res_pjsip reload: calls in progress stay up. Does nothing when they're unchanged,
# so it can run daily from cron to pick up renewals.
#
# Usage: scripts/tls-cert.sh                        the cert the bundled Caddy got for PUBLIC_HOSTNAME
#        scripts/tls-cert.sh fullchain.pem privkey.pem   any other (e.g. certbot's live/<host>/)
set -eu
cd "$(dirname "$0")/.."

if [ $# -eq 2 ]; then
  cert=$1 key=$2
elif [ $# -eq 0 ]; then
  host=$(sed -n 's/^PUBLIC_HOSTNAME=\([^ #]*\).*/\1/p' .env)
  # Caddy keeps <host>.crt (full chain) and <host>.key per ACME issuer; take the newest.
  dir=$(ls -dt data/caddy/caddy/certificates/*/"$host" 2>/dev/null | head -n 1)
  if [ -z "$dir" ]; then
    echo "No Caddy certificate for $host. Pass fullchain.pem and privkey.pem instead." >&2
    exit 1
  fi
  cert=$dir/$host.crt key=$dir/$host.key
else
  sed -n '7,8s/^# \{0,1\}//p' "$0" >&2
  exit 2
fi

if cmp -s "$cert" data/tls/fullchain.pem && cmp -s "$key" data/tls/privkey.pem; then
  exit 0
fi
uid=$(sed -n 's/^APP_UID=\([0-9]*\).*/\1/p' .env); uid=${uid:-1000}
gid=$(sed -n 's/^APP_GID=\([0-9]*\).*/\1/p' .env); gid=${gid:-1000}
# Asterisk and the api both run as the app user and only need to read these. Asterisk re-reads them
# only when their mtime changes: install (not cp -p) gives them a fresh one.
install -o "$uid" -g "$gid" -m 644 "$cert" data/tls/fullchain.pem.new
install -o "$uid" -g "$gid" -m 600 "$key" data/tls/privkey.pem.new
mv data/tls/fullchain.pem.new data/tls/fullchain.pem
mv data/tls/privkey.pem.new data/tls/privkey.pem
docker compose exec -T asterisk asterisk -rx 'module reload res_pjsip.so'
openssl x509 -noout -subject -enddate -in data/tls/fullchain.pem
