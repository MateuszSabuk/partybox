#!/usr/bin/env bash
# Health check + live Wi-Fi client counter.
#
#   sudo ./scripts/doctor.sh            one-off checks
#   sudo ./scripts/doctor.sh --watch    also show how many phones are associated, refreshing every 2 s
#                                       (use this for the "does the Pi's Wi-Fi hold 12+ phones?" test)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

IFACE=${IFACE:-wlan0}
fail=0
check() { # check "label" command...
  local label=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$label"; else printf '  %s✗%s %s\n' "$R" "$N" "$label"; fail=1; fi
}

stations() { iw dev "$IFACE" station dump 2>/dev/null | grep -c '^Station' || true; }

if [ "${1:-}" = "--watch" ]; then
  echo "Associated stations on $IFACE (Ctrl-C to stop). Ask people to join one by one and watch for the point where it stops."
  max=0
  while true; do
    n=$(stations); [ "$n" -gt "$max" ] && max=$n
    printf '\r  phones on Wi-Fi: %-3s  (peak %s)   players in game: %-3s ' "$n" "$max" \
      "$(curl -fs http://localhost/api/info >/dev/null && echo '?' || echo 'server down')"
    sleep 2
  done
fi

step "Service"
check "partybox.service is active" systemctl is-active --quiet $PB_SERVICE
check "enabled at boot" systemctl is-enabled --quiet $PB_SERVICE
check "HTTP answers on :80" curl -fs -m 3 http://localhost/api/info
check "Android probe returns 204" sh -c '[ "$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://localhost/generate_204)" = 204 ]'
domain=$(cfg_get server.domain); tls=$(cfg_get server.tls.enabled); ip=$(cfg_get network.ip); ip=${ip:-192.168.4.1}
if [ "$tls" = true ]; then
  check "HTTPS answers on :443" curl -fsk -m 3 https://localhost/api/info
  cert=$(cfg_get server.tls.cert)
  if [ -f "$cert" ]; then
    openssl x509 -in "$cert" -noout -checkend $((3 * 86400)) >/dev/null && ok "certificate valid for >3 days" || { printf '  %s✗%s certificate expires soon/expired\n' "$R" "$N"; fail=1; }
  fi
fi

step "Network"
if have nmcli; then
  check "hotspot/AP profile is active" sh -c "nmcli -t -f NAME connection show --active | grep -q '^PartyBox'"
  check "Pi has $ip" sh -c "ip -4 addr | grep -q 'inet $ip/'"
  check "NetworkManager DNS rules installed" test -f "$PB_DNSMASQ_CONF"
  if [ -n "$domain" ]; then
    got=$(getent hosts "$domain" | awk '{print $1}' | head -1)
    # the Pi itself may use another resolver – ask the party DNS directly if dig exists
    have dig && got=$(dig +short +time=2 +tries=1 @"$ip" "$domain" | head -1)
    [ "$got" = "$ip" ] && ok "$domain -> $ip" || warn "$domain resolves to '${got:-nothing}' from here (phones use the party DNS – check after reboot)"
  fi
else
  warn "nmcli not found – network checks skipped"
fi
if have iw && iw dev "$IFACE" info >/dev/null 2>&1; then
  ok "$IFACE: $(iw dev "$IFACE" info | awk '/type|channel|ssid/{printf "%s ", $0}' | tr -s ' \t' ' ')"
  ok "phones on Wi-Fi right now: $(stations)   (--watch for a live counter)"
fi
if have rfkill && rfkill list wifi 2>/dev/null | grep -q 'Soft blocked: yes'; then warn "Wi-Fi is soft-blocked: sudo rfkill unblock wifi / set the country (raspi-config)"; fail=1; fi
if have iw; then c=$(iw reg get 2>/dev/null | awk '/country/{print $2; exit}'); case "$c" in 00:*|"") warn "Wi-Fi country not set (regulatory domain '00') – set it with raspi-config or setup.sh --country" ;; *) ok "Wi-Fi country $c" ;; esac; fi

step "Power / thermals"
if have vcgencmd; then
  t=$(vcgencmd get_throttled | cut -d= -f2)
  [ "$t" = 0x0 ] && ok "no under-voltage or throttling so far" || warn "throttled flags $t – use the official 27 W (5V/5A) supply or a PD power bank that does 5A; 0x50005 = under-voltage"
  ok "$(vcgencmd measure_temp)"
fi

echo
[ "$fail" = 0 ] && ok "all good" || { printf '%sSome checks failed%s – logs: journalctl -u %s -n 50\n' "$R" "$N" "$PB_SERVICE"; exit 1; }
