#!/bin/sh
# Kiosk launcher (Issue #12, technology-stack 26.7). Run by the systemd user
# unit home-digital-signage-kiosk.service as the Desktop user.
# Waits for nginx only (not the Backend: the Frontend recovers by itself).
# Starting Chromium before nginx answers leaves it on an error page, so give
# up after 60 s and let systemd restart this script.
set -eu
url=http://127.0.0.1/
profile=${XDG_STATE_HOME:-$HOME/.local/state}/home-digital-signage/chromium
# Count attempts instead of reading the wall clock (it may jump at NTP sync).
# Each attempt takes at most about 2 s, so 30 attempts are about 60 s.
tries=0
until curl -fs -o /dev/null --max-time 1 "$url"; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    printf '%s\n' 'kiosk: nginx did not answer within about 60 s' >&2
    exit 1
  fi
  sleep 1
done
mkdir -p "$profile"
# --password-store=basic: no OS keyring, so no keyring password prompt (#6).
# Nothing is saved in this profile. Whether the prompt is gone is Pi check P6.
exec chromium \
  --kiosk \
  --user-data-dir="$profile" \
  --password-store=basic \
  --no-first-run \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  "$url"
