#!/usr/bin/env bash
# Install (or renew) the HTTPS certificate for your domain.
#
#   sudo ./scripts/install-cert.sh /path/to/fullchain.pem /path/to/privkey.pem [domain]
#
# Get the certificate on a machine WITH internet (the Pi has none at parties), e.g. with certbot's
# DNS-01 challenge, then copy it over. Let's Encrypt certs last 90 days – renew before an event.
# Phones check the cert against their own clock and the domain name, so make sure the domain you
# pass here is the one the cert was issued for (a wildcard *.example.com cert works for party.example.com).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need_root "$@"

CERT=${1:-}; KEY=${2:-}; DOMAIN=${3:-}
[ -f "$CERT" ] && [ -f "$KEY" ] || die "usage: $0 fullchain.pem privkey.pem [domain]"
[ -f "$PB_ETC/config.json" ] || die "PartyBox is not installed yet – run setup.sh first"
[ -n "$DOMAIN" ] || DOMAIN=$(cfg_get server.domain)
[ -n "$DOMAIN" ] || die "no domain known – pass it as the 3rd argument"

step "Checking certificate"
openssl x509 -in "$CERT" -noout >/dev/null 2>&1 || die "$CERT is not a valid PEM certificate"
# the key must belong to the certificate
a=$(openssl x509 -in "$CERT" -noout -pubkey | openssl sha256)
b=$(openssl pkey -in "$KEY" -pubout 2>/dev/null | openssl sha256) || die "cannot read private key"
[ "$a" = "$b" ] || die "private key does not match the certificate"
ok "key matches certificate"
if ! openssl x509 -in "$CERT" -noout -checkend $((7 * 86400)) >/dev/null; then warn "certificate expires within 7 days!"; fi
openssl x509 -in "$CERT" -noout -enddate | sed 's/^/  /'
if openssl x509 -in "$CERT" -noout -checkhost "$DOMAIN" 2>/dev/null | grep -q 'does match'; then ok "certificate covers $DOMAIN"
else warn "certificate does NOT list '$DOMAIN' – phones will show a security warning"; fi

step "Installing"
run install -o root -g "$PB_USER" -m 644 "$CERT" "$PB_ETC/fullchain.pem"
run install -o root -g "$PB_USER" -m 640 "$KEY" "$PB_ETC/privkey.pem"
if [ "$DRY" != 1 ]; then
  node "$HERE/write-config.mjs" --out "$PB_ETC/config.json" --domain "$DOMAIN" --tls on
  chown root:"$PB_USER" "$PB_ETC/config.json"; chmod 640 "$PB_ETC/config.json"
fi
# make sure the Pi's DNS also answers for the domain (setup.sh does this too; harmless if repeated)
if [ -d "$(dirname "$PB_DNSMASQ_CONF")" ] && ! grep -Fq "address=/$DOMAIN/" "$PB_DNSMASQ_CONF" 2>/dev/null; then
  ip=$(cfg_get network.ip); ip=${ip:-192.168.4.1}
  if [ "$DRY" = 1 ]; then echo "  [dry-run] append address=/$DOMAIN/$ip to $PB_DNSMASQ_CONF"; else echo "address=/$DOMAIN/$ip" >>"$PB_DNSMASQ_CONF"; fi
  warn "DNS entry added – it takes effect after the party network restarts (reboot)"
fi
run systemctl restart $PB_SERVICE
ok "HTTPS enabled – players: https://$DOMAIN/"
