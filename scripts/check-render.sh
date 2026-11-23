#!/bin/sh
# Render check for the Issue #13 72-hour run (technology-stack 27.5). Run every
# 5 min as the Desktop user by the user unit
# home-digital-signage-render-check.timer. Records only the SHA-256 of a
# screenshot. The image can show schedule titles, so it is kept in
# XDG_RUNTIME_DIR (tmpfs) and deleted at once.
# CHANGED: the hash differs from the last one. SAME: the same hash (the clock
# changes every minute, so the screen may have stopped). CAPTURE_FAIL: no
# screenshot; this is not a stopped screen. CHANGED alone does not mean the
# screen is fine: that is checked by eye.
set -u
dir=${HDS_RENDER_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/home-digital-signage}

log() { printf 'check-render: %s\n' "$1" >&2; }
uptime_cs() { awk '{ split($1, a, "."); print a[1] * 100 + substr(a[2] "00", 1, 2) }' /proc/uptime; }

started=$(uptime_cs)
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
[ -d "$dir" ] || { log 'render directory is missing'; exit 1; }
exec 9>>"$dir/.render.lock" || { log 'cannot open the lock file'; exit 1; }
flock -n 9 || exit 0
umask 077

seq=$(cat "$dir/render-seq" 2>/dev/null) || seq=0
case $seq in '' | *[!0-9]*) seq=0 ;; esac
seq=$((seq + 1))
{ printf '%s\n' "$seq" > "$dir/render-seq.tmp" && mv "$dir/render-seq.tmp" "$dir/render-seq"; } ||
  log 'cannot save the sequence number'
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || boot=ERR
uptime=$(awk '{ print int($1) }' /proc/uptime)

result=CAPTURE_FAIL reason='' capture_ms='' hash=''
if [ -z "${WAYLAND_DISPLAY-}" ] || [ -z "${XDG_RUNTIME_DIR-}" ] || [ ! -d "${XDG_RUNTIME_DIR-}" ]; then
  reason=no_display
elif ! command -v grim > /dev/null 2>&1; then
  reason=no_grim
else
  img="$XDG_RUNTIME_DIR/hds-render-check.$$.png"
  trap 'rm -f "$img"' EXIT
  trap 'rm -f "$img"; exit 1' INT TERM
  capture_started=$(uptime_cs)
  if timeout 20 grim "$img" > /dev/null 2>&1; then
    if [ -s "$img" ]; then
      hash=$(sha256sum "$img" 2>/dev/null | cut -d ' ' -f 1)
      [ -n "$hash" ] || reason=hash_failed
    else
      reason=empty
    fi
  else
    reason=grim_failed
  fi
  rm -f "$img"
  capture_ms=$((($(uptime_cs) - capture_started) * 10))
  if [ -n "$hash" ]; then
    last=$(cat "$dir/render-last" 2>/dev/null) || last=''
    if [ "$hash" = "$last" ]; then result=SAME; else result=CHANGED; fi
    printf '%s\n' "$hash" > "$dir/render-last" || log 'cannot save the last hash'
  fi
fi

header='ts_utc,seq,boot_id,uptime_s,script_ms,result,reason,capture_ms,sha256'
row="$ts,$seq,$boot,$uptime,$((($(uptime_cs) - started) * 10)),$result,$reason,$capture_ms,$hash"
day=$(printf '%s' "$ts" | cut -c1-10 | tr -d -)
file="$dir/render-$day.csv"
# Check before the redirection: ">>" creates the file.
if [ -e "$file" ]; then out=$row; else out="$header
$row"; fi
if ! printf '%s\n' "$out" >> "$file"; then
  log 'cannot write the CSV row'
  exit 1
fi
exit 0
