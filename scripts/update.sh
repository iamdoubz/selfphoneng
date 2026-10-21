#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Updates a docker compose install (the folder scripts/install.sh set up) to a release (08 §3.1).
# Installs from pulled images (Portainer and the like) don't use it: change the image tag and
# redeploy (admin guide, maintenance.md). Run from anywhere:
#
# Usage: scripts/update.sh [vX.Y.Z] [--yes] [--force]
#   vX.Y.Z   the release to update to (default: the newest that isn't a pre-release)
#   --yes    don't ask before starting
#   --force  go on with calls in progress, low disk space or a failed backup
#
# Checks first (Docker, an unchanged checkout, free disk, the release's changelog and new .env
# settings), backs up, compacts Asterisk's logs, builds the new images while the old ones still
# run, restarts, then checks the result. If the check fails it goes back: the old code and images,
# and the backup too if the database was changed. Each run is logged in data/update-logs/.
# Everything in { }: bash reads it all before running, so checking out the release (which can
# change this file) can't change what runs.
{
set -euo pipefail
cd "$(dirname "$0")/.."

target='' yes='' force=''
for a in "$@"; do
  case $a in
    --yes) yes=1 ;;
    --force) force=1 ;;
    v[0-9]*) target=$a ;;
    *) sed -n '7,10s/^# \{0,1\}//p' "$0" >&2; exit 2 ;;
  esac
done

mkdir -p data/update-logs
log=data/update-logs/update-$(date +%Y%m%d-%H%M%S).log
exec > >(tee -a "$log") 2>&1

say() { printf '\n== %s\n' "$*"; }
die() { echo "update: $*" >&2; exit 1; }
# A check --force can override.
need() { if [ -n "$force" ]; then echo "update: $1 (going on: --force)"; else die "$1"; fi; }

command -v docker >/dev/null && docker compose version >/dev/null 2>&1 \
  || die "Docker with the compose plugin is required"
command -v git >/dev/null || die "git is required"
[ -d .git ] && [ -f .env ] || die "run this in the SelfPhoneNG folder scripts/install.sh set up"
# The bundled Caddy is in a compose profile: keep it if it's running.
profile=()
[ -n "$(docker ps -q --filter label=com.docker.compose.project=selfphoneng \
  --filter label=com.docker.compose.service=caddy)" ] && profile=(--profile caddy)
dc() { docker compose "${profile[@]}" "$@"; }
ast() { dc exec -T asterisk asterisk -rx "$1"; }

say "Checks"
changed=$(git status --porcelain --untracked-files=no)
[ -z "$changed" ] || die "files in this folder were changed; undo or save them first:
$changed"
for d in data "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /)"; do
  free=$(df -Pk "$d" 2>/dev/null | awk 'NR==2 {print $4}') || continue
  [ "${free:-0}" -ge $((3 * 1024 * 1024)) ] \
    || need "under 3 GB free on $(df -P "$d" | awk 'NR==2 {print $6}') (backup + new images)"
done
git fetch --quiet --tags origin || die "can't reach the git remote ($(git remote get-url origin))"
current=$(dc exec -T api cat /app/VERSION 2>/dev/null || sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)
[ -n "$target" ] || target=$(git tag -l 'v[0-9]*' | grep -v -- - | sort -V | tail -1)
git rev-parse -q --verify "refs/tags/$target" >/dev/null || die "no release $target"
[ "$target" != "v$current" ] || { echo "Already on $target."; exit 0; }
[ "$(printf '%s\n' "v$current" "$target" | sort -V | head -1)" = "v$current" ] \
  || die "$target is older than the running v$current. To go back, restore a backup (scripts/restore.sh)."
echo "v$current → $target"
echo
git show "$target:CHANGELOG.md" | awk -v stop="## v$current " 'index($0, stop) == 1 {exit} /^## v/ {p=1} p'
new_keys=$(comm -13 <(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' .env | sort -u) \
  <(git show "$target:.env.example" | sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' | sort -u))
[ -z "$new_keys" ] || echo "New settings in .env.example, not in your .env (defaults apply): $new_keys"
ast 'core show version' >/dev/null 2>&1 || die "Asterisk isn't running; start it first (docker compose up -d)"
calls=$(ast 'core show channels count' | sed -n 's/^\([0-9]*\) active call.*/\1/p' || true)
[ "${calls:-0}" -eq 0 ] || need "$calls call(s) in progress; try again later"
if [ -z "$yes" ]; then
  read -r -p "Update to $target now? Calls drop for about a minute. Type yes: " ok
  [ "$ok" = yes ] || die "stopped, nothing changed"
fi

# What the check compares against, and what going back needs.
prev=$(git rev-parse HEAD)
regs_before=$(ast 'pjsip show registrations' | grep -cw Registered || true)
mig() { dc exec -T postgres psql -U selfphoneng -d selfphoneng -tAc 'select count(*) from drizzle.__drizzle_migrations'; }
mig_before=$(mig) || die "can't read the database; is postgres running?"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)

say "Backup"
backup=''
if ! dc exec -T api true 2>/dev/null; then
  need "the api isn't running, so there's no backup first"
elif dc exec -T api test -f dist/backup-cli.js; then
  backup=$(dc exec -T api node dist/backup-cli.js | tail -1) || need "the backup failed"
  [ -z "$backup" ] || echo "data/backups/$backup"
else
  echo "v$current can't back up from here; the new version backs up before changing the database."
fi

say "Compacting Asterisk's logs"
# Each log gzipped next to itself and emptied in place (Asterisk appends); gone after 90 days.
dc exec -T asterisk sh -c 'cd /var/log/asterisk && t=$(date +%Y%m%d-%H%M%S) &&
  for f in *.log; do [ -s "$f" ] || continue; gzip -9c "$f" > "${f%.log}-$t.log.gz" && : > "$f"; done
  find . -maxdepth 1 -name "*.log.gz" -mtime +90 -delete; du -sh .'

say "Building $target (the running version stays up)"
git -c advice.detachedHead=false checkout -q "$target"
if ! { dc pull --ignore-buildable --quiet && dc build; }; then
  git -c advice.detachedHead=false checkout -q "$prev"
  die "building $target failed; nothing changed"
fi

say "Restarting"
dc up -d

# The api answers with the new version, Asterisk is up, and trunks registered before still are.
check() {
  local want=$1 i
  for i in $(seq 60); do
    dc exec -T api node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" \
      2>/dev/null && break
    [ "$i" -lt 60 ] || { echo "the api doesn't answer"; return 1; }
    sleep 3
  done
  [ "$(dc exec -T api cat /app/VERSION)" = "$want" ] || { echo "the api isn't v$want"; return 1; }
  for i in $(seq 20); do
    ast 'core waitfullybooted' >/dev/null 2>&1 && break
    [ "$i" -lt 20 ] || { echo "Asterisk didn't start"; return 1; }
    sleep 3
  done
  for i in $(seq 30); do
    [ "$(ast 'pjsip show registrations' | grep -cw Registered || true)" -ge "$regs_before" ] && break
    [ "$i" -lt 30 ] || { echo "trunks registered before aren't now"; return 1; }
    sleep 3
  done
  echo "api v$want answers, Asterisk is up, $regs_before trunk(s) registered"
}

say "Checking"
if check "${target#v}"; then
  errors=$(dc logs --no-log-prefix --since "$started" api asterisk 2>&1 \
    | grep -E '"level":(50|60)|ERROR\[' | tail -5 || true)
  [ -z "$errors" ] || printf 'Errors logged since the update (look into them):\n%s\n' "$errors"
  docker image prune -f >/dev/null
  echo "$(date -Is) v$current → $target ok" >> data/update-logs/history
  say "Updated to $target"
  exit 0
fi

say "The check failed: going back to v$current"
# The new api's own backup, made just before it migrated, beats the one above.
own=$(dc logs --no-log-prefix --since "$started" api 2>&1 \
  | sed -n 's/.*"backup":"\(selfphoneng-[0-9-]*\.tar\.gz\)".*backup before migrating made.*/\1/p' | tail -1)
git -c advice.detachedHead=false checkout -q "$prev"
dc build
if [ "$(mig)" != "$mig_before" ]; then
  restore=${own:-$backup}
  [ -n "$restore" ] || die "the database was changed and there's no backup to go back to; see $log"
  echo "The database was changed: restoring data/backups/$restore"
  printf 'yes\n' | scripts/restore.sh "data/backups/$restore"
fi
dc up -d
if check "$current"; then result="failed, back on v$current"; else result="failed, and v$current didn't come back"; fi
echo "$(date -Is) v$current → $target $result" >> data/update-logs/history
die "update to $target $result; see $log"
}
