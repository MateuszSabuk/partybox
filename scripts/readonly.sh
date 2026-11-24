#!/usr/bin/env bash
# Optional: make the Pi safe to unplug without shutting down (overlay filesystem, root is read-only).
#
#   sudo ./scripts/readonly.sh on|off        (reboots are required for either)
#
# While on, everything written after boot lives in RAM and disappears at the next boot – including
# player sessions/scores. That is usually what you want for a party box. To change config, install a
# new game or renew the certificate: run `readonly.sh off`, reboot, make the change, `readonly.sh on`, reboot.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need_root "$@"
have raspi-config || die "raspi-config not found (Raspberry Pi OS only)"
case "${1:-}" in
  on)  run raspi-config nonint enable_overlayfs; run raspi-config nonint enable_bootro; ok "read-only mode enabled – reboot to apply" ;;
  off) run raspi-config nonint disable_bootro; run raspi-config nonint disable_overlayfs; ok "read-only mode disabled – reboot to apply" ;;
  *)   die "usage: $0 on|off" ;;
esac
