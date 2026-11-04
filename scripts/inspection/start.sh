#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
#
# Starts the inspection image prepared by setup.sh: Xvfb, then Thunderbird on a fresh copy of the throw-away profile,
# then, once the add-on has written its connection file, the bridge of this checkout on standard input and output
# (an MCP stdio server, for example behind mcp-proxy). The output of Xvfb and Thunderbird goes to files, never to
# standard output, which belongs to the MCP protocol.
#
# Usage: bash scripts/inspection/start.sh
set -euo pipefail

OPT=/opt/commonpost-inspection
here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/../.." && pwd -P)"
work="$(mktemp -d)"
mkdir -p "$work/home" "$work/xdg" /tmp/.X11-unix
chmod 700 "$work/xdg"
chmod 1777 /tmp/.X11-unix 2>/dev/null || true
cp -R "$OPT/profile" "$work/profile"

export HOME="$work/home" XDG_RUNTIME_DIR="$work/xdg" TMPDIR=/tmp DISPLAY=:99 LANG=C.UTF-8 \
  MOZ_CRASHREPORTER_DISABLE=1 MOZ_DISABLE_AUTO_SAFE_MODE=1 MOZ_NO_REMOTE=1 MOZ_ENABLE_WAYLAND=0 \
  DBUS_SESSION_BUS_ADDRESS=disabled: NO_AT_BRIDGE=1 GSETTINGS_BACKEND=memory

Xvfb :99 -screen 0 1280x900x24 -nolisten tcp -noreset > "$work/xvfb.log" 2>&1 < /dev/null &
for _ in $(seq 1 40); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.25; done

/opt/thunderbird/thunderbird --profile "$work/profile" --no-remote > "$work/thunderbird.log" 2>&1 < /dev/null &
tb=$!
conn=/tmp/commonpost-mcp/connection.json
for _ in $(seq 1 300); do
  [ -s "$conn" ] && break
  kill -0 "$tb" 2>/dev/null || break
  sleep 0.5
done
if [ ! -s "$conn" ]; then
  echo "inspection: the add-on did not write $conn; end of the Thunderbird log:" >&2
  tail -n 40 "$work/thunderbird.log" >&2 || true
fi
exec node "$root/mcp-bridge.cjs"
