#!/usr/bin/env bash
# Opens the TV host screen full-screen. Started automatically at desktop login by setup.sh.
# Uses plain http://localhost (the Pi itself is always trusted as host, and localhost is a
# secure context, so no certificate or DNS is needed for the TV).
set -u
# Only one instance, even if both the labwc and the XDG autostart entries fire.
exec 9>/tmp/partybox-kiosk.lock
flock -n 9 || exit 0

URL=${PARTYBOX_HOST_URL:-http://localhost/host}
BROWSER=$(command -v chromium || command -v chromium-browser || true)
[ -n "$BROWSER" ] || { echo "kiosk: chromium not installed" >&2; exit 1; }

# wait for the server (up to ~60 s) – the desktop can start before the service does
for _ in $(seq 1 60); do
  curl -fs -o /dev/null "http://localhost/api/info" && break
  sleep 1
done

# a hard power-off leaves a "restore pages?" bubble behind; keep the profile fresh instead
PROFILE=$(mktemp -d /tmp/partybox-kiosk.XXXXXX)
trap 'rm -rf "$PROFILE"' EXIT

# restart the browser if it ever crashes
while true; do
  "$BROWSER" --kiosk --user-data-dir="$PROFILE" \
    --noerrdialogs --disable-infobars --disable-session-crashed-bubble --no-first-run \
    --disable-translate --disable-features=Translate --check-for-update-interval=31536000 \
    --autoplay-policy=no-user-gesture-required --overscroll-history-navigation=0 \
    "$URL"
  sleep 2
done
