#!/bin/sh
# Release switch and rollback (Issue #12, technology-stack 26.9).
# Usage (as root):
#   sh activate-release.sh activate <staging-dir>
#   sh activate-release.sh rollback --schema-checked
# <staging-dir> is named <YYYYMMDD-HHMMSS>-<git short SHA> and holds dist/,
# scripts/, package.json, package-lock.json and node_modules/ (npm ci done).
# The DB is never migrated here; switching back is only safe because of that.
# HDS_BASE, HDS_RELEASE_OWNER and HDS_HEALTH_TRIES exist for tests only.
set -eu
base=${HDS_BASE:-/opt/home-digital-signage}
owner=${HDS_RELEASE_OWNER:-root:root}
health_tries=${HDS_HEALTH_TRIES:-15}
unit=home-digital-signage-backend.service
keep=3
fail() {
  printf 'activate-release: %s\n' "$1" >&2
  exit 1
}

if [ "$owner" = root:root ] && [ "$(id -u)" -ne 0 ]; then
  fail 'run as root (sudo)'
fi
[ -d "$base/releases" ] || fail "missing $base/releases"
exec 8>"$base/.activate.lock"
flock -n 8 || fail 'another activation is running'

# Atomic replacement of a symbolic link: rename(2) via mv -T.
point() {
  ln -s "$2" "$base/$1.tmp"
  mv -T "$base/$1.tmp" "$base/$1"
}

# Backend directly, then the same path as the Kiosk (nginx). /ping alone
# answers even when the DB is unusable (10.9), so the API is checked too.
healthy() {
  page=$(mktemp)
  ok=1
  for url in http://127.0.0.1:3000/ping \
    http://127.0.0.1:3000/api/published-states \
    http://127.0.0.1/api/published-states; do
    curl -fs -o /dev/null --max-time 3 "$url" || ok=0
  done
  if [ "$ok" -eq 1 ]; then
    curl -fs -o "$page" --max-time 3 http://127.0.0.1/ || ok=0
  fi
  if [ "$ok" -eq 1 ]; then
    cmp -s "$page" "$1/dist/frontend/index.html" || ok=0
  fi
  rm -f "$page"
  [ "$ok" -eq 1 ]
}

# Wait up to about 30 s for the restarted Backend.
restart_and_check() {
  systemctl restart "$unit"
  tries=0
  until healthy "$1"; do
    tries=$((tries + 1))
    [ "$tries" -lt "$health_tries" ] || return 1
    sleep 2
  done
}

# Keep the newest $keep releases; never remove current or previous.
prune() {
  cur=$(readlink "$base/current" || :)
  prev=$(readlink "$base/previous" || :)
  ls -1 "$base/releases" | sort -r | tail -n +$((keep + 1)) |
    while IFS= read -r name; do
      dir=$base/releases/$name
      [ "$dir" = "$cur" ] || [ "$dir" = "$prev" ] || rm -rf -- "$dir"
    done
}

case "${1-}" in
  activate)
    staging=${2-}
    [ -n "$staging" ] && [ -d "$staging" ] || fail 'staging directory not found'
    name=$(basename -- "$staging")
    printf '%s\n' "$name" | grep -Eq '^[0-9]{8}-[0-9]{6}-[0-9a-f]{7,40}$' ||
      fail 'name must be <YYYYMMDD-HHMMSS>-<git short SHA>'
    for f in dist/backend/main.js dist/frontend/index.html \
      scripts/with-backend-lock.sh scripts/kiosk.sh package.json node_modules; do
      [ -e "$staging/$f" ] || fail "staging lacks $f"
    done
    new=$base/releases/$name
    [ ! -e "$new" ] && [ ! -e "$new.tmp" ] || fail "release $name already exists"
    # Copy and fix ownership before anything points at it. A failed copy
    # leaves nothing behind, and current is not changed.
    trap 'rm -rf -- "$new.tmp"' EXIT
    cp -R -- "$staging" "$new.tmp"
    chown -R -h "$owner" "$new.tmp"
    chmod -R u=rwX,go=rX "$new.tmp"
    mv -T "$new.tmp" "$new"
    trap - EXIT
    old=$(readlink "$base/current" || :)
    point current "$new"
    if restart_and_check "$new"; then
      [ -z "$old" ] || point previous "$old"
      prune
      printf 'activate-release: %s is active\n' "$name"
      exit 0
    fi
    if [ -n "$old" ]; then
      point current "$old"
      systemctl restart "$unit" || :
      fail "health check failed; switched back to $(basename -- "$old")"
    fi
    fail 'health check failed and there is no previous release'
    ;;
  rollback)
    # The operator confirms that the previous release supports the current
    # DB schema (26.9). Without it, do not roll back.
    [ "${2-}" = --schema-checked ] ||
      fail 'confirm DB schema compatibility, then pass --schema-checked'
    prev=$(readlink "$base/previous" || :)
    [ -n "$prev" ] && [ -d "$prev" ] || fail 'no previous release'
    cur=$(readlink "$base/current" || :)
    point current "$prev"
    if restart_and_check "$prev"; then
      [ -z "$cur" ] || point previous "$cur"
      printf 'activate-release: rolled back to %s\n' "$(basename -- "$prev")"
      exit 0
    fi
    fail 'health check failed after rollback; check the logs'
    ;;
  *)
    fail 'usage: activate <staging-dir> | rollback --schema-checked'
    ;;
esac
