#!/usr/bin/env bash
# Shared helpers for the PartyBox scripts. Source, don't execute.

PB_PREFIX=${PB_PREFIX:-/opt/partybox}
PB_DATA=${PB_DATA:-/var/lib/partybox}
PB_ETC=${PB_ETC:-/etc/partybox}
PB_USER=${PB_USER:-partybox}
PB_SERVICE=partybox
PB_NM_WIFI=PartyBox
PB_NM_ETH=PartyBox-eth
PB_DNSMASQ_CONF=/etc/NetworkManager/dnsmasq-shared.d/partybox.conf
DRY=${DRY:-0}

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=; G=; Y=; R=; N=; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# run <cmd...>: execute, or just print in --dry-run
run() {
  if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*"; return 0; fi
  "$@"
}

# write_file <path> <mode>  (content on stdin)
write_file() {
  local path=$1 mode=${2:-644}
  if [ "$DRY" = 1 ]; then
    printf '  [dry-run] write %s (mode %s):\n' "$path" "$mode"
    sed 's/^/      | /'
    return 0
  fi
  mkdir -p "$(dirname "$path")"
  cat >"$path"
  chmod "$mode" "$path"
}

need_root() {
  [ "$DRY" = 1 ] && return 0
  [ "$(id -u)" -eq 0 ] || die "run as root:  sudo $0 $*"
}

have() { command -v "$1" >/dev/null 2>&1; }

nm_has_con() { nmcli -t -f NAME connection show 2>/dev/null | grep -Fxq "$1"; }

# Read a value out of the installed config (empty if missing)
cfg_get() {
  [ -f "$PB_ETC/config.json" ] || return 0
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1]));const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],c);if(v!==undefined)console.log(v)' "$PB_ETC/config.json" "$1" 2>/dev/null || true
}
