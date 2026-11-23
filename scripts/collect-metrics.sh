#!/bin/sh
# Metrics for the Issue #13 72-hour run (technology-stack 27). Run every 60 s
# as root by home-digital-signage-metrics.timer. Reads only, and appends one
# CSV row to the metrics directory. Never writes Published State data, Secrets
# or file contents: only numbers, states and checked meta values.
# Columns that are not taken this time are empty; values that could not be
# taken are ERR (27.3).
set -u
dir=${HDS_METRICS_DIR:-/var/lib/home-digital-signage-metrics}
data=${HDS_DATA_DIR:-/var/lib/home-digital-signage}
base=${HDS_BASE:-/opt/home-digital-signage}
sys=${HDS_SYSFS:-/sys}
# Per-process files only (tests use a fake tree); /proc/uptime etc. stay real.
proc=${HDS_PROC:-/proc}
kiosk_user=${HDS_KIOSK_USER:-signage}
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

log() { printf 'collect-metrics: %s\n' "$1" >&2; }
# Uptime in 1/100 s: a monotonic clock (the wall clock may jump at NTP sync).
uptime_cs() { awk '{ split($1, a, "."); print a[1] * 100 + substr(a[2] "00", 1, 2) }' /proc/uptime; }

started=$(uptime_cs)
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
[ -d "$dir" ] || { log 'metrics directory is missing'; exit 1; }
# Type=oneshot never runs twice at once; the lock also covers manual runs.
exec 9>>"$dir/.lock" || { log 'cannot open the lock file'; exit 1; }
flock -n 9 || exit 0
umask 077

row=''
# Only plain tokens reach the CSV; anything else becomes ERR.
add() {
  case $1 in
    *[!A-Za-z0-9._:+-]*) row="$row,ERR" ;;
    *) row="$row,$1" ;;
  esac
}
# addn N VALUES...: N values, or N times ERR when the count is different.
addn() {
  n=$1
  shift
  if [ $# -eq "$n" ]; then
    for v; do add "$v"; done
  else
    while [ "$n" -gt 0 ]; do add ERR; n=$((n - 1)); done
  fi
}
# or_err VALUE: ERR when empty.
or_err() { if [ -n "$1" ]; then add "$1"; else add ERR; fi; }

seq=$(cat "$dir/seq" 2>/dev/null) || seq=0
case $seq in '' | *[!0-9]*) seq=0 ;; esac
seq=$((seq + 1))
{ printf '%s\n' "$seq" > "$dir/seq.tmp" && mv "$dir/seq.tmp" "$dir/seq"; } ||
  log 'cannot save the sequence number'
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || boot=ERR
uptime=$(awk '{ print int($1) }' /proc/uptime)

# PSS and the journal size are taken about every 10 minutes (27.4).
slow=1
last=$(cat "$dir/slow" 2>/dev/null) || last=''
last_boot=${last% *}
last_up=${last#* }
case $last_up in '' | *[!0-9]*) last_up='' ;; esac
if [ "$last_boot" = "$boot" ] && [ -n "$last_up" ] &&
  [ $((uptime - last_up)) -lt 595 ]; then
  slow=0
fi
if [ "$slow" -eq 1 ]; then
  printf '%s %s\n' "$boot" "$uptime" > "$dir/slow" || log 'cannot save the slow-metrics time'
fi

release=$(readlink "$base/current" 2>/dev/null) && release=${release##*/} || release=ERR

# unit_info UNIT [OPTIONS...]: "ActiveState NRestarts ControlGroup" from
# systemctl [OPTIONS...] show UNIT.
unit_info() {
  unit=$1
  shift
  systemctl "$@" show -p ActiveState -p NRestarts -p ControlGroup "$unit" 2>/dev/null |
    awk -F= '$1 == "ActiveState" { a = $2 } $1 == "NRestarts" { r = $2 }
      $1 == "ControlGroup" { c = $2 }
      END { print (a == "" ? "ERR" : a), (r == "" ? "ERR" : r), (c == "" ? "-" : c) }'
}
# cgroup_pids CGROUP: process IDs of a unit, or ERR.
cgroup_pids() {
  if [ "$1" = - ]; then return 0; fi
  cat "$sys/fs/cgroup$1/cgroup.procs" 2>/dev/null || echo ERR
}
# measure PIDS...: sets p_n p_rss p_pss p_ticks p_fds (sums of the processes).
# - A process that has exited (no /proc/PID, or a zombie) is not counted.
# - A value that cannot be read from a living process makes that sum ERR; the
#   other sums and processes are still measured (sums and error flags are
#   kept apart so that ERR never enters arithmetic).
# - p_pss is empty when this is not a slow round.
measure() {
  p_n=0 p_rss=0 p_pss=0 p_ticks=0 p_fds=0
  e_rss=0 e_pss=0 e_ticks=0 e_fds=0
  case " $* " in *' ERR '*)
    p_n=ERR p_rss=ERR p_pss=ERR p_ticks=ERR p_fds=ERR
    [ "$slow" -eq 1 ] || p_pss=''
    return 0 ;;
  esac
  for p; do
    case $p in '' | *[!0-9]*) continue ;; esac
    # Field 3 is the state; utime and stime are fields 14 and 15.
    st=$(awk '{ sub(/^.*\) /, ""); print $1, $12 + $13 }' "$proc/$p/stat" 2>/dev/null) || st=''
    t=${st#* }
    r=$(awk '$1 == "VmRSS:" { print $2 }' "$proc/$p/status" 2>/dev/null) || r=''
    if fds=$(ls -A "$proc/$p/fd" 2>/dev/null); then
      if [ -n "$fds" ]; then f=$(printf '%s\n' "$fds" | awk 'END { print NR }'); else f=0; fi
    else
      f=''
    fi
    s=''
    if [ "$slow" -eq 1 ]; then
      s=$(awk '$1 == "Pss:" { print $2 }' "$proc/$p/smaps_rollup" 2>/dev/null) || s=''
    fi
    # Exited during the round, or a zombie: not counted.
    [ -d "$proc/$p" ] || continue
    [ "${st%% *}" != Z ] || continue
    p_n=$((p_n + 1))
    case $t in '' | *[!0-9]*) e_ticks=1 ;; *) p_ticks=$((p_ticks + t)) ;; esac
    case $r in '' | *[!0-9]*) e_rss=1 ;; *) p_rss=$((p_rss + r)) ;; esac
    case $f in '' | *[!0-9]*) e_fds=1 ;; *) p_fds=$((p_fds + f)) ;; esac
    if [ "$slow" -eq 1 ]; then
      case $s in '' | *[!0-9]*) e_pss=1 ;; *) p_pss=$((p_pss + s)) ;; esac
    fi
  done
  [ "$e_ticks" -eq 0 ] || p_ticks=ERR
  [ "$e_rss" -eq 0 ] || p_rss=ERR
  [ "$e_fds" -eq 0 ] || p_fds=ERR
  [ "$e_pss" -eq 0 ] || p_pss=ERR
  [ "$slow" -eq 1 ] || p_pss=''
}

# CPU (raw counters) and load average.
addn 8 $(awk '$1 == "cpu" { print $2, $3, $4, $5, $6, $7, $8, $9; exit }' /proc/stat 2>/dev/null)
addn 3 $(awk '{ print $1, $2, $3 }' /proc/loadavg 2>/dev/null)

# Memory.
addn 4 $(awk '$1 == "MemTotal:" { t = $2 } $1 == "MemAvailable:" { a = $2 }
  $1 == "SwapTotal:" { st = $2 } $1 == "SwapFree:" { sf = $2 }
  END { if (t != "" && a != "" && st != "" && sf != "") print t, a, st, sf }' /proc/meminfo 2>/dev/null)

# Backend: every process of the unit.
set -- $(unit_info home-digital-signage-backend.service)
if [ $# -ne 3 ]; then set -- ERR ERR -; fi
backend_state=$1 backend_restarts=$2
measure $(cgroup_pids "$3")
backend_main=$(systemctl show -p MainPID --value home-digital-signage-backend.service 2>/dev/null) || backend_main=ERR
add "$backend_state"; add "$backend_restarts"; or_err "$backend_main"
add "$p_rss"; add "$p_pss"; add "$p_ticks"; add "$p_fds"

# nginx.
set -- $(unit_info nginx.service)
if [ $# -ne 3 ]; then set -- ERR ERR -; fi
add "$1"; add "$2"

# Kiosk (user unit of the Desktop user) and every Chromium process.
set -- $(unit_info home-digital-signage-kiosk.service --user -M "$kiosk_user@")
if [ $# -ne 3 ]; then set -- ERR ERR -; fi
kiosk_state=$1 kiosk_restarts=$2 kiosk_cgroup=$3
if [ "$kiosk_state" = ERR ]; then
  # Fallback (27.10): Chromium processes of the Desktop user.
  measure $(pgrep -u "$kiosk_user" -x chromium 2>/dev/null)
else
  # Chromium moves its main process out of the unit into its own scope
  # (app-org.chromium.Chromium-<PID>.scope) next to the unit, so both are
  # counted (27.4). Pi check of Issue #13 stage 2.
  pids=$(cgroup_pids "$kiosk_cgroup")
  if [ "$kiosk_cgroup" != - ]; then
    for scope in "$sys/fs/cgroup${kiosk_cgroup%/*}"/app-org.chromium.Chromium-*.scope; do
      [ -d "$scope" ] || continue
      pids="$pids $(cat "$scope/cgroup.procs" 2>/dev/null || echo ERR)"
    done
  fi
  measure $pids
fi
add "$kiosk_state"; add "$kiosk_restarts"
add "$p_n"; add "$p_rss"; add "$p_pss"; add "$p_ticks"

# Temperature, fan and throttling.
or_err "$(cat "$sys/class/thermal/thermal_zone0/temp" 2>/dev/null)"
fan=''
for d in "$sys"/class/thermal/cooling_device*; do
  [ "$(cat "$d/type" 2>/dev/null)" = pwm-fan ] || continue
  fan=$(cat "$d/cur_state" 2>/dev/null)
  break
done
or_err "$fan"
throttled=$(vcgencmd get_throttled 2>/dev/null) && throttled=${throttled#throttled=} || throttled=''
or_err "$throttled"

# Storage.
or_err "$(df -Pk / 2>/dev/null | awk 'NR == 2 { print $4 }')"
for f in signage.db signage.db-wal signage.db-shm; do
  or_err "$(stat -c %s "$data/$f" 2>/dev/null)"
done
if [ "$slow" -eq 1 ]; then
  # "Archived and active journals take up 24.0M in the file system."
  or_err "$(journalctl --disk-usage 2>/dev/null | awk '{
    for (i = 1; i <= NF; i++) if ($i ~ /^[0-9.]+[BKMGT]$/) {
      u = substr($i, length($i)); n = substr($i, 1, length($i) - 1)
      m = 1
      if (u == "K") m = 1024; else if (u == "M") m = 1048576
      else if (u == "G") m = 1073741824; else if (u == "T") m = 1099511627776
      printf "%d\n", n * m; exit
    } }')"
else
  add ''
fi

# Network and time synchronization.
or_err "$(cat "$sys/class/net/wlan0/operstate" 2>/dev/null)"
if route=$(ip route show default 2>/dev/null); then
  if [ -n "$route" ]; then add 1; else add 0; fi
else
  add ERR
fi
or_err "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)"

# API (30 fields).
api=$(node "$here/collect-metrics-api.mjs" 2>/dev/null) || api=''
old_ifs=$IFS
IFS=,
set -- $api
IFS=$old_ifs
addn 30 "$@"

ended=$(uptime_cs)
header='ts_utc,seq,boot_id,uptime_s,script_ms,release'
header="$header,cpu_user,cpu_nice,cpu_system,cpu_idle,cpu_iowait,cpu_irq,cpu_softirq,cpu_steal,load1,load5,load15"
header="$header,mem_total_kb,mem_available_kb,swap_total_kb,swap_free_kb"
header="$header,backend_state,backend_restarts,backend_main_pid,backend_rss_kb,backend_pss_kb,backend_cpu_ticks,backend_fds"
header="$header,nginx_state,nginx_restarts"
header="$header,kiosk_state,kiosk_restarts,chromium_procs,chromium_rss_kb,chromium_pss_kb,chromium_cpu_ticks"
header="$header,temp_millic,fan_state,throttled"
header="$header,root_avail_kb,db_bytes,wal_bytes,shm_bytes,journal_bytes"
header="$header,wlan_operstate,default_route,ntp_synchronized"
header="$header,time_result,time_ms,availability,states_result,states_ms"
for k in schedule current_weather hourly_weather weekly_weather rain_forecast; do
  header="$header,${k}_last_attempt_at,${k}_last_result,${k}_data_updated_at,${k}_expires_at,${k}_source"
done
body=$row
row=''
add "$ts"; add "$seq"; add "$boot"; add "$uptime"; add $(((ended - started) * 10)); add "$release"
row="${row#,}$body"

day=$(printf '%s' "$ts" | cut -c1-10 | tr -d -)
file="$dir/metrics-$day.csv"
# A failed write is reported and does not affect the next run (27.2).
# Check before the redirection: ">>" creates the file.
if [ -e "$file" ]; then out=$row; else out="$header
$row"; fi
if ! printf '%s\n' "$out" >> "$file"; then
  log 'cannot write the CSV row'
  exit 1
fi
exit 0
