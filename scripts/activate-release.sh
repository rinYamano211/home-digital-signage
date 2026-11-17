#!/bin/sh
# Release switch and rollback (Issue #12, technology-stack 26.9).
# Usage (as root):
#   sh activate-release.sh activate <staging-dir>
#   sh activate-release.sh rollback --schema-checked
# <staging-dir> is named <YYYYMMDD-HHMMSS>-<git short SHA> and holds dist/,
# scripts/, package.json, package-lock.json and node_modules/ (npm ci done).
# The DB is never migrated here; switching back is only safe because of that.
# Exit codes: 0 done; 1 failed, and the release that was running before is
# back and healthy; 2 failed, and that release is not healthy either (act now).
# HDS_BASE, HDS_RELEASE_OWNER and HDS_HEALTH_TRIES exist for tests only.
set -eu
base=${HDS_BASE:-/opt/home-digital-signage}
owner=${HDS_RELEASE_OWNER:-root:root}
health_tries=${HDS_HEALTH_TRIES:-15}
unit=home-digital-signage-backend.service
keep=3
say() {
  printf 'activate-release: %s\n' "$1" >&2
}
fail() {
  say "$1"
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

# GET through nginx (the Kiosk's path) and compare with the release's file.
# A missing file would come back as index.html (SPA fallback) with 200, so a
# byte comparison is needed; a status code alone would be a false positive.
same_as_release() {
  out=$(mktemp)
  if curl -fs -o "$out" --max-time 3 "http://127.0.0.1$2" &&
    cmp -s "$out" "$1/dist/frontend$3"; then
    rm -f "$out"
    return 0
  fi
  rm -f "$out"
  return 1
}

# Backend directly, then nginx. /ping alone answers even when the DB is
# unusable (10.9), so the API is checked too. The static JS/CSS that
# index.html references must come back unchanged as well.
healthy() {
  for url in http://127.0.0.1:3000/ping \
    http://127.0.0.1:3000/api/published-states \
    http://127.0.0.1/api/published-states; do
    curl -fs -o /dev/null --max-time 3 "$url" || return 1
  done
  same_as_release "$1" / /index.html || return 1
  assets=$(grep -Eo '(src|href)="/assets/[^"]+"' "$1/dist/frontend/index.html" |
    sed -E 's/^(src|href)="//; s/"$//') || :
  [ -n "$assets" ] || return 1
  for asset in $assets; do
    same_as_release "$1" "$asset" "$asset" || return 1
  done
}

# Restart the Backend on $1 and wait up to about 30 s. A failed restart is a
# failed check, so the caller can switch back (set -e does not apply inside
# a function called from an if condition).
restart_and_check() {
  if ! systemctl restart "$unit"; then
    say "systemctl restart failed for $(basename -- "$1")"
    return 1
  fi
  tries=0
  until healthy "$1"; do
    tries=$((tries + 1))
    [ "$tries" -lt "$health_tries" ] || return 1
    sleep 2
  done
}

# Point current back at $1 (the release that was running) and check it.
switch_back() {
  point current "$1"
  if restart_and_check "$1"; then
    say "$2; switched back to $(basename -- "$1") and it is healthy"
    exit 1
  fi
  say "$2; switched back to $(basename -- "$1") but it is NOT healthy; check the logs"
  exit 2
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
      say "$name is active"
      exit 0
    fi
    if [ -z "$old" ]; then
      say 'health check failed and there is no previous release; check the logs'
      exit 2
    fi
    switch_back "$old" "health check failed for $name"
    ;;
  rollback)
    # The operator confirms that the previous release supports the current
    # DB schema (26.9). Without it, do not roll back.
    [ "${2-}" = --schema-checked ] ||
      fail 'confirm DB schema compatibility, then pass --schema-checked'
    prev=$(readlink "$base/previous" || :)
    [ -n "$prev" ] && [ -d "$prev" ] || fail 'no previous release'
    cur=$(readlink "$base/current" || :)
    [ -n "$cur" ] || fail 'no current release'
    point current "$prev"
    if restart_and_check "$prev"; then
      point previous "$cur"
      say "rolled back to $(basename -- "$prev")"
      exit 0
    fi
    # previous is left as it was.
    switch_back "$cur" "health check failed for $(basename -- "$prev")"
    ;;
  *)
    fail 'usage: activate <staging-dir> | rollback --schema-checked'
    ;;
esac
