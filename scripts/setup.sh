#!/usr/bin/env bash
# PartyBox installer for Raspberry Pi OS (Bookworm or newer – needs NetworkManager).
#
#   sudo ./scripts/setup.sh [options]
#
# What it does (each step can be skipped):
#   1. installs Node 22 (if < 20), rsync, iw, Chromium
#   2. copies the app to /opt/partybox as a locked-down `partybox` user, config in /etc/partybox
#   3. creates the Wi-Fi hotspot (or an Ethernet DHCP/DNS for an external AP) with NetworkManager,
#      plus DNS that points your domain at the Pi and answers phones' "is there internet?" probes
#   4. installs a systemd service on ports 80/443 (auto-start, auto-restart)
#   5. sets the TV to boot straight into the host screen in kiosk mode
#
# Nothing on the network is switched while you run it – the new Wi-Fi/Ethernet profile starts on the
# next reboot, so your SSH session survives. Use --dry-run to see everything it would do.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(dirname "$HERE")"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

MODE=wifi            # wifi = Pi's own radio is the AP | ethernet = external AP/router wired to the Pi
SSID=PartyBox
PASS=letsplay123
DOMAIN=
IP=192.168.4.1
COUNTRY=PL           # Wi-Fi regulatory domain – set YOUR country (legal channels + 5 GHz)
BAND=bg              # bg = 2.4 GHz (works on every phone) | a = 5 GHz (more capacity, fewer old phones)
CHANNEL=
IFACE=
ETH_IFACE=eth0
KIOSK=1
KIOSK_USER=${SUDO_USER:-}
DO_NETWORK=1
NODE_MAJOR=22

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; cat <<EOF

Options:
  --mode wifi|ethernet     AP source (default wifi)
  --ssid NAME              Wi-Fi name        (default $SSID)
  --password PASS          8-63 chars, or '' for an open network (default $PASS)
  --ip ADDR                Pi address on the party network (default $IP)
  --domain NAME            your domain (cert + DNS), e.g. party.example.com
  --country CC             Wi-Fi country code (default $COUNTRY)
  --band bg|a              2.4 GHz or 5 GHz (default $BAND)
  --channel N              fixed channel (default: automatic)
  --iface NAME             Wi-Fi interface (default wlan0)
  --eth-iface NAME         Ethernet interface for --mode ethernet (default eth0)
  --kiosk-user NAME        desktop user for the TV browser (default: the user who ran sudo)
  --no-kiosk               don't touch the desktop / autostart
  --no-network             don't create the hotspot (install the app only)
  --dry-run                print what would happen, change nothing
EOF
}

while [ $# -gt 0 ]; do
  case $1 in
    --mode) MODE=$2; shift 2 ;;
    --ssid) SSID=$2; shift 2 ;;
    --password) PASS=$2; shift 2 ;;
    --ip) IP=$2; shift 2 ;;
    --domain) DOMAIN=$2; shift 2 ;;
    --country) COUNTRY=$2; shift 2 ;;
    --band) BAND=$2; shift 2 ;;
    --channel) CHANNEL=$2; shift 2 ;;
    --iface) IFACE=$2; shift 2 ;;
    --eth-iface) ETH_IFACE=$2; shift 2 ;;
    --kiosk-user) KIOSK_USER=$2; shift 2 ;;
    --no-kiosk) KIOSK=0; shift ;;
    --no-network) DO_NETWORK=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown option: $1" ;;
  esac
done

# ---------- validation ----------
[ "$MODE" = wifi ] || [ "$MODE" = ethernet ] || die "--mode must be wifi or ethernet"
[ "$BAND" = bg ] || [ "$BAND" = a ] || die "--band must be bg or a"
[[ $IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--ip must look like 192.168.4.1"
[[ $COUNTRY =~ ^[A-Za-z]{2}$ ]] || die "--country must be a 2-letter code (PL, DE, US…)"
COUNTRY=${COUNTRY^^}
[ -n "$SSID" ] && [ ${#SSID} -le 32 ] || die "--ssid must be 1-32 characters"
if [ -n "$PASS" ] && { [ ${#PASS} -lt 8 ] || [ ${#PASS} -gt 63 ]; }; then die "--password must be 8-63 characters (or empty for open)"; fi
[ -z "$DOMAIN" ] || [[ $DOMAIN =~ ^[A-Za-z0-9.-]+$ ]] || die "--domain looks invalid"
[ -n "$IFACE" ] || IFACE=wlan0
need_root "$@"

# ---------- 0. preflight ----------
step "Preflight"
if [ -r /proc/device-tree/model ]; then ok "$(tr -d '\0' </proc/device-tree/model)"; else warn "not a Raspberry Pi? (continuing)"; fi
if [ "$DO_NETWORK" = 1 ] && ! have nmcli && [ "$DRY" != 1 ]; then
  die "NetworkManager (nmcli) not found. Use Raspberry Pi OS Bookworm or newer, or pass --no-network."
fi
if [ "$DRY" = 1 ]; then warn "DRY RUN – nothing will be changed"; fi
if [ "$DO_NETWORK" = 1 ] && [ "$MODE" = wifi ] && have nmcli; then
  active=$(nmcli -t -f DEVICE,TYPE,STATE device 2>/dev/null | grep -c "^$IFACE:wifi:connected" || true)
  if [ "$active" -gt 0 ]; then warn "$IFACE is currently a Wi-Fi *client*. It becomes the hotspot after reboot, so use Ethernet for internet/SSH afterwards."; fi
fi

# ---------- 1. packages ----------
step "Packages"
run apt-get update -qq
run apt-get install -y -qq ca-certificates curl rsync iw rfkill
if [ "$KIOSK" = 1 ]; then
  run apt-get install -y -qq chromium || run apt-get install -y -qq chromium-browser
  # Colour emoji font for the TV browser. The built-in UI uses SVG icons and doesn't need it, but a game
  # that prints emoji would otherwise show empty boxes (missing glyph) or flat outline symbols.
  run apt-get install -y -qq fonts-noto-color-emoji
fi
node_major=0
have node && node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 20 ]; then
  step "Node.js $NODE_MAJOR (found: ${node_major:-none})"
  if [ "$DRY" = 1 ]; then echo "  [dry-run] curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - && apt-get install -y nodejs"
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y -qq nodejs
  fi
else
  ok "Node $(node -v) already installed"
fi

# ---------- 2. app + user ----------
step "Install app to $PB_PREFIX"
if ! id "$PB_USER" >/dev/null 2>&1; then
  run useradd --system --home-dir "$PB_DATA" --create-home --shell /usr/sbin/nologin "$PB_USER"
fi
run install -d -o "$PB_USER" -g "$PB_USER" -m 755 "$PB_PREFIX"
run install -d -o "$PB_USER" -g "$PB_USER" -m 755 "$PB_DATA"
run install -d -o root -g "$PB_USER" -m 750 "$PB_ETC"
run rsync -a --delete --exclude node_modules --exclude .git --exclude /data --exclude /config.json --exclude /test "$SRC/" "$PB_PREFIX/"
run chown -R "$PB_USER:$PB_USER" "$PB_PREFIX"
run runuser -u "$PB_USER" -- sh -c "cd '$PB_PREFIX' && npm ci --omit=dev --no-audit --no-fund"

step "Config  $PB_ETC/config.json"
if [ "$DRY" = 1 ]; then
  echo "  [dry-run] node write-config.mjs --out $PB_ETC/config.json --ssid '$SSID' --password '***' --ip $IP --domain '$DOMAIN' --data-dir $PB_DATA"
else
  node "$HERE/write-config.mjs" --out "$PB_ETC/config.json" --ssid "$SSID" --password "$PASS" --ip "$IP" --domain "$DOMAIN" --data-dir "$PB_DATA"
  chown root:"$PB_USER" "$PB_ETC/config.json"
  chmod 640 "$PB_ETC/config.json"
fi

# ---------- 3. network ----------
if [ "$DO_NETWORK" = 1 ]; then
  step "Network ($MODE mode)"

  # DNS for the party network. NetworkManager's "shared" mode runs its own dnsmasq and reads this folder.
  {
    echo "# managed by PartyBox setup.sh"
    echo "# Phones' internet probes: answering them with the Pi (which replies 204/Success) keeps phones"
    echo "# on this Wi-Fi without a 'sign in' popup or 'no internet, switch to mobile data' prompts."
    for h in connectivitycheck.gstatic.com connectivitycheck.android.com clients3.google.com www.google.com \
             captive.apple.com www.apple.com www.msftconnecttest.com www.msftncsi.com detectportal.firefox.com; do
      echo "address=/$h/$IP"
    done
    # (DHCP range/gateway are generated by NetworkManager itself – don't duplicate them here, a
    #  second overlapping dhcp-range stops dnsmasq from starting.)
    if [ -n "$DOMAIN" ]; then echo "address=/$DOMAIN/$IP"; fi
  } | write_file "$PB_DNSMASQ_CONF" 644

  if [ "$MODE" = wifi ]; then
    if have raspi-config; then run raspi-config nonint do_wifi_country "$COUNTRY"; else run iw reg set "$COUNTRY"; fi
    run rfkill unblock wifi
    if [ "$DRY" != 1 ] && nm_has_con "$PB_NM_WIFI"; then nmcli connection delete "$PB_NM_WIFI" >/dev/null; fi
    args=(connection add type wifi ifname "$IFACE" con-name "$PB_NM_WIFI" autoconnect yes ssid "$SSID"
      802-11-wireless.mode ap 802-11-wireless.band "$BAND" 802-11-wireless.powersave 2
      ipv4.method shared ipv4.addresses "$IP/24" ipv6.method disabled
      connection.autoconnect-priority 100)
    if [ -n "$CHANNEL" ]; then args+=(802-11-wireless.channel "$CHANNEL"); fi
    if [ -n "$PASS" ]; then
      args+=(wifi-sec.key-mgmt wpa-psk wifi-sec.proto rsn wifi-sec.pairwise ccmp wifi-sec.group ccmp wifi-sec.psk "$PASS")
    fi
    if [ "$DRY" = 1 ]; then echo "  [dry-run] nmcli ${args[*]/$PASS/***}"; else nmcli "${args[@]}" >/dev/null; fi
    ok "hotspot profile '$PB_NM_WIFI': SSID '$SSID' on $BAND, gateway $IP"
  else
    if [ "$DRY" != 1 ] && nm_has_con "$PB_NM_ETH"; then nmcli connection delete "$PB_NM_ETH" >/dev/null; fi
    args=(connection add type ethernet ifname "$ETH_IFACE" con-name "$PB_NM_ETH" autoconnect yes
      ipv4.method shared ipv4.addresses "$IP/24" ipv6.method disabled connection.autoconnect-priority 100)
    if [ "$DRY" = 1 ]; then echo "  [dry-run] nmcli ${args[*]}"; else nmcli "${args[@]}" >/dev/null; fi
    ok "Ethernet profile '$PB_NM_ETH' on $ETH_IFACE: Pi serves DHCP/DNS at $IP"
    warn "Put your external router in ACCESS POINT / bridge mode with its own DHCP OFF, plug its LAN port into the Pi,"
    warn "and give it SSID '$SSID' / password '$PASS' (the QR code on the TV shows exactly those)."
  fi
fi

# ---------- 4. service ----------
step "systemd service"
NODE_BIN=$(command -v node || echo /usr/bin/node)
write_file /etc/systemd/system/$PB_SERVICE.service 644 <<EOF
[Unit]
Description=PartyBox party-game server
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
User=$PB_USER
Group=$PB_USER
WorkingDirectory=$PB_PREFIX
Environment=NODE_ENV=production
Environment=PARTYBOX_CONFIG=$PB_ETC/config.json
ExecStart=$NODE_BIN src/server.js
Restart=always
RestartSec=2
# ports 80/443 without root
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$PB_DATA

[Install]
WantedBy=multi-user.target
EOF
run systemctl daemon-reload
run systemctl enable $PB_SERVICE.service
run systemctl restart $PB_SERVICE.service
ok "service enabled and started (auto-restarts, starts on boot)"

# ---------- 5. kiosk ----------
if [ "$KIOSK" = 1 ]; then
  step "TV kiosk (Chromium on the host screen)"
  if [ -z "$KIOSK_USER" ] || [ "$KIOSK_USER" = root ]; then
    warn "no desktop user known (pass --kiosk-user NAME). Skipping kiosk."
  else
    KHOME=$(getent passwd "$KIOSK_USER" | cut -d: -f6 || true)
    if [ -z "$KHOME" ] && [ "$DRY" != 1 ]; then die "user '$KIOSK_USER' does not exist"; fi
    KHOME=${KHOME:-/home/$KIOSK_USER}
    LAUNCH="$PB_PREFIX/scripts/kiosk.sh"
    run chmod +x "$LAUNCH"
    # labwc = Pi OS Bookworm+ default compositor. XDG autostart covers X11/other sessions.
    AUTOSTART="$KHOME/.config/labwc/autostart"
    run install -d -o "$KIOSK_USER" -g "$KIOSK_USER" "$KHOME/.config/labwc" "$KHOME/.config/autostart"
    if [ "$DRY" = 1 ]; then echo "  [dry-run] ensure '$LAUNCH &' line in $AUTOSTART"
    else
      touch "$AUTOSTART"
      grep -Fq "$LAUNCH" "$AUTOSTART" || echo "$LAUNCH &" >>"$AUTOSTART"
      chown "$KIOSK_USER:$KIOSK_USER" "$AUTOSTART"
    fi
    write_file "$KHOME/.config/autostart/partybox-kiosk.desktop" 644 <<EOF
[Desktop Entry]
Type=Application
Name=PartyBox kiosk
Exec=$LAUNCH
EOF
    [ "$DRY" = 1 ] || chown "$KIOSK_USER:$KIOSK_USER" "$KHOME/.config/autostart/partybox-kiosk.desktop"
    if have raspi-config; then run raspi-config nonint do_boot_behaviour B4; ok "boot to desktop with auto-login"; fi
    warn "Also disable screen blanking: raspi-config → Display Options → Screen Blanking → No."
  fi
fi

# ---------- done ----------
step "Done"
if [ "$DRY" = 1 ]; then echo "Dry run finished – nothing was changed."; exit 0; fi
cat <<EOF
  • App:        http://localhost/host   (TV)      players: http://${DOMAIN:-$IP}/
  • Service:    systemctl status $PB_SERVICE      logs: journalctl -u $PB_SERVICE -f
  • Config:     $PB_ETC/config.json  (edit, then: sudo systemctl restart $PB_SERVICE)
  • HTTPS:      sudo $PB_PREFIX/scripts/install-cert.sh fullchain.pem privkey.pem
  • Check-up:   sudo $PB_PREFIX/scripts/doctor.sh

  Reboot now to start the party network:   sudo reboot
EOF
