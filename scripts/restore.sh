#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Restores a SelfPhoneNG backup (04 §8.1): the database, voicemail, custom sounds, music on hold
# and, if the backup has them, recordings. Stops the api and Asterisk while it works; the api
# rebuilds Asterisk's config from the restored database when it starts.
# .env must hold the APP_SECRET the backup was made with (SIP and trunk passwords are encrypted
# with it): the script checks, and stops if it doesn't match.
#
# Usage: scripts/restore.sh <selfphoneng-YYYYMMDD-HHMM.tar.gz>   (run from anywhere)
set -eu
[ $# -eq 1 ] || { sed -n '9s/^# \{0,1\}//p' "$0" >&2; exit 2; }
file=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd "$(dirname "$0")/.."
die() { echo "restore: $*" >&2; exit 1; }

manifest=$(tar -xzOf "$file" manifest.json 2>/dev/null) || die "$1 is not a SelfPhoneNG backup"
field() { printf '%s' "$manifest" | tr -d '\n' | sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\).*/\1/p"; }
[ "$(field version)" = 1 ] || die "unknown backup format $(field version) (this version reads 1)"
secret=$(sed -n 's/^APP_SECRET=\([^ #]*\).*/\1/p' .env)
[ "$(printf 'selfphoneng-backup:%s' "$secret" | sha256sum | cut -c1-16)" = "$(field secretCheck)" ] \
  || die "APP_SECRET in .env is not the one this backup was made with. Put the old one back in .env (passwords in the backup are encrypted with it)."
folders=$(tar -tzf "$file" | cut -d/ -f1 | sort -u | grep -xE 'voicemail|sounds-custom|moh|recordings' | tr '\n' ' ')

echo "Backup made $(field createdAt), with: database ${folders}"
echo "This REPLACES the current database and those folders. Type yes to go on:"
read -r ok
[ "$ok" = yes ] || die "stopped, nothing changed"

docker compose stop api asterisk
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -q -U selfphoneng -d postgres; do sleep 1; done
psql() { docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U selfphoneng "$@"; }
psql -d postgres -c 'DROP DATABASE IF EXISTS selfphoneng WITH (FORCE)' \
  -c 'CREATE DATABASE selfphoneng OWNER selfphoneng'
tar -xzOf "$file" db.sql | psql -d selfphoneng >/dev/null

uid=$(sed -n 's/^APP_UID=\([0-9]*\).*/\1/p' .env); uid=${uid:-1000}
gid=$(sed -n 's/^APP_GID=\([0-9]*\).*/\1/p' .env); gid=${gid:-1000}
for d in $folders; do rm -rf "data/$d"; done
# shellcheck disable=SC2086 # one word per folder
tar -xzf "$file" -C data $folders
for d in $folders; do
  chown -R "$uid:$gid" "data/$d" 2>/dev/null || sudo chown -R "$uid:$gid" "data/$d"
done

docker compose up -d asterisk api
echo "Restored. The api rebuilds Asterisk's config as it starts; sign in with the backup's passwords."
