#!/bin/sh
# Usage: sh scripts/with-backend-lock.sh backend|provision
# Fixed layout: SIGNAGE_DATA_DIR/{backend.lock,signage.db}; never unlink the lock.
# Exit 73: contention (2s); 74: unsafe path/platform; 75: lock operation failure.
set -eu
case "${1-}" in
  backend) entry=main.js ;;
  provision) entry=storage/provision.js ;;
  *) printf '%s\n' 'lock: invalid command' >&2; exit 74 ;;
esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dir=${SIGNAGE_DATA_DIR:-/var/lib/home-digital-signage}
node "$root/dist/backend/storage/paths.js" "$dir" || exit 74
umask 077
# noclobber creates only when absent. Existing files are checked before/after open.
if [ ! -e "$dir/backend.lock" ]; then
  (set -C; : > "$dir/backend.lock") 2>/dev/null || :
fi
node "$root/dist/backend/storage/paths.js" "$dir" || exit 74
exec 9>>"$dir/backend.lock"
if flock -x -w 2 -E 73 9; then
  exec node "$root/dist/backend/$entry"
else
  code=$?
  if [ "$code" -eq 73 ]; then
    printf '%s\n' 'lock: timeout' >&2; exit 73
  fi
  printf '%s\n' 'lock: operation failed' >&2; exit 75
fi
