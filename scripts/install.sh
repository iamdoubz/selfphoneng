#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# One-command install (spec 01 §1.3). Run from the repo root: ./scripts/install.sh
set -eu
cd "$(dirname "$0")/.."

# 1. Docker.
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Docker with the compose plugin is required: https://docs.docker.com/engine/install/" >&2
  exit 1
fi

# Replace KEY=... in .env (values are safe for sed: hex, base64 and user input with | escaped).
set_env() {
  v=$(printf '%s' "$2" | sed 's/[|&\\]/\\&/g')
  sed -i "s|^$1=.*|$1=$v|" .env
}

# 2. .env with generated secrets.
if [ ! -f .env ]; then
  cp .env.example .env
  set_env POSTGRES_PASSWORD "$(openssl rand -hex 32)" # hex: it is embedded in DATABASE_URL
  set_env AMI_SECRET "$(openssl rand -hex 32)"
  set_env APP_SECRET "$(openssl rand -base64 32)"
  printf 'Public hostname (e.g. pbx.example.com): '; read -r host
  printf 'Admin email: '; read -r email
  stty -echo 2>/dev/null || true
  printf 'Admin password (min 10 chars): '; read -r pw; echo
  stty echo 2>/dev/null || true
  set_env PUBLIC_HOSTNAME "$host"
  set_env INITIAL_ADMIN_EMAIL "$email"
  set_env INITIAL_ADMIN_PASSWORD "$pw"
  chmod 600 .env
  echo "Wrote .env"
fi

# 3. Data folders owned by the app user.
uid=$(sed -n 's/^APP_UID=\([0-9]*\).*/\1/p' .env); uid=${uid:-1000}
gid=$(sed -n 's/^APP_GID=\([0-9]*\).*/\1/p' .env); gid=${gid:-1000}
for d in postgres asterisk-generated voicemail recordings sounds-custom moh astdb asterisk-logs tls backups caddy; do
  mkdir -p "data/$d"
done
# postgres manages its own folder's ownership; everything else is shared by asterisk and the api.
chown -R "$uid:$gid" data/asterisk-generated data/voicemail data/recordings data/sounds-custom data/moh \
  data/astdb data/asterisk-logs data/tls data/backups 2>/dev/null \
  || sudo chown -R "$uid:$gid" data/asterisk-generated data/voicemail data/recordings data/sounds-custom \
       data/moh data/astdb data/asterisk-logs data/tls data/backups

# 4. Start.
printf 'Use bundled Caddy for HTTPS? [y/N] '; read -r caddy
case "$caddy" in
  [yY]*) docker compose --profile caddy up -d --build ;;
  *)
    docker compose up -d --build
    echo "Configure your reverse proxy from deploy/nginx/selfphoneng.conf.example"
    ;;
esac

# 5. Done.
host=$(sed -n 's/^PUBLIC_HOSTNAME=\([^ #]*\).*/\1/p' .env)
echo "SelfPhoneNG is starting. Open https://$host/ (health: curl http://127.0.0.1:8080/healthz)"
