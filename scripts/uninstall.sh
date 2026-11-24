#!/usr/bin/env bash
# Remove PartyBox. Keeps the config and player data unless --purge is given.
#   sudo ./scripts/uninstall.sh [--purge] [--dry-run] [--kiosk-user NAME]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
PURGE=0; KIOSK_USER=${SUDO_USER:-}
while [ $# -gt 0 ]; do
  case $1 in
    --purge) PURGE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --kiosk-user) KIOSK_USER=$2; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
need_root "$@"

step "Service"
run systemctl disable --now $PB_SERVICE.service || true
run rm -f /etc/systemd/system/$PB_SERVICE.service
run systemctl daemon-reload

step "Network profiles + DNS rules"
if have nmcli; then
  for c in "$PB_NM_WIFI" "$PB_NM_ETH"; do
    if nm_has_con "$c"; then run nmcli connection delete "$c"; ok "removed profile $c"; fi
  done
fi
run rm -f "$PB_DNSMASQ_CONF"

step "Kiosk autostart"
if [ -n "$KIOSK_USER" ] && KHOME=$(getent passwd "$KIOSK_USER" | cut -d: -f6) && [ -n "$KHOME" ]; then
  run rm -f "$KHOME/.config/autostart/partybox-kiosk.desktop"
  if [ -f "$KHOME/.config/labwc/autostart" ]; then run sed -i '\#partybox/scripts/kiosk.sh#d' "$KHOME/.config/labwc/autostart"; fi
fi

step "Files"
run rm -rf "$PB_PREFIX"
if [ "$PURGE" = 1 ]; then
  run rm -rf "$PB_ETC" "$PB_DATA"
  if id "$PB_USER" >/dev/null 2>&1; then run userdel "$PB_USER"; fi
  ok "config, data and user removed"
else
  ok "kept $PB_ETC and $PB_DATA (use --purge to delete)"
fi
echo; ok "Uninstalled. Reboot to restore normal Wi-Fi behaviour."
