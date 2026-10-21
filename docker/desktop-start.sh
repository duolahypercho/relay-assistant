#!/bin/sh
# SPDX-License-Identifier: MIT
set -eu
mkdir -p "$HOME" /tmp/relay-jobs /tmp/relay-runtime
chmod 700 /tmp/relay-runtime
export XDG_RUNTIME_DIR=/tmp/relay-runtime
export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/relay-runtime/bus
export GTK_MODULES=atk-bridge
export ACCESSIBILITY_ENABLED=1
dbus-daemon --session --fork --address="$DBUS_SESSION_BUS_ADDRESS"
Xvfb :0 -screen 0 1280x800x24 -nolisten tcp -ac &
xpid=$!
trap 'kill "$xpid" 2>/dev/null || true' EXIT INT TERM
for attempt in $(seq 1 80); do
  if xdotool getdisplaygeometry >/dev/null 2>&1; then break; fi
  sleep 0.1
done
openbox >/tmp/window-manager.log 2>&1 &
# This entrypoint owns the sole browser in this newly started container. Its old
# processes and sockets are gone, but the persistent profile may name the prior
# container's hostname. Remove only Chromium's stale singleton metadata.
rm -f "$HOME/chromium/SingletonLock" "$HOME/chromium/SingletonSocket" "$HOME/chromium/SingletonCookie"
chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run \
  --disable-background-networking --disable-extensions --disable-sync --force-renderer-accessibility \
  --proxy-server=http://127.0.0.1:8088 --proxy-bypass-list='<-loopback>' --disable-quic \
  --user-data-dir="$HOME/chromium" --window-size=1240,740 --window-position=20,30 \
  --app=file:///opt/relay/desktop-home.html >/tmp/browser.log 2>&1 &
for attempt in $(seq 1 150); do
  if xdotool search --onlyvisible --name 'Relay.*A little room to work' >/dev/null 2>&1; then
    touch /tmp/relay-desktop-ready
    break
  fi
  sleep 0.2
done
if [ ! -f /tmp/relay-desktop-ready ]; then
  echo 'The desktop browser did not open.' >&2
  exit 1
fi
wait "$xpid"
