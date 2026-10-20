#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Update to the latest code (08 §3.1). Migrations run when the api starts. Calls in progress drop
# when Asterisk's container is recreated, so run it when the phones are quiet.
# Usage: scripts/update.sh   (run from anywhere)
set -eu
cd "$(dirname "$0")/.."
git pull --ff-only
profile=$(docker ps -q --filter label=com.docker.compose.project=selfphoneng --filter label=com.docker.compose.service=caddy | grep -q . && echo '--profile caddy' || true)
# shellcheck disable=SC2086 # empty or one flag
docker compose $profile pull --ignore-buildable # postgres, caddy
# shellcheck disable=SC2086
docker compose $profile build --pull
# shellcheck disable=SC2086
docker compose $profile up -d
echo "Updated to $(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json) ($(git rev-parse --short HEAD))"
