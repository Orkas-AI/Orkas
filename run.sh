#!/bin/bash
# Open-source Orkas launcher. The script's own directory is the checkout root.
# Behavior: an in-app relaunch waits for its exact owner process to exit. A
# direct launch closes only the previous source instance owned by this checkout,
# then starts a new instance in the foreground.
#
# Usage:
#   ./run.sh
#
# Orkas source builds use exactly one server environment: global prod.
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "[Orkas] $APP_DIR/package.json not found; check the source directory layout." >&2
  exit 1
fi

is_wsl() {
  [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ] || {
    [ -r /proc/version ] && grep -qiE 'microsoft|wsl' /proc/version
  }
}

if is_wsl; then
  if command -v cmd.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
    WIN_APP_DIR="$(wslpath -w "$APP_DIR")"
    cat >&2 <<EOF
[Orkas] WSL/WSLg detected.
[Orkas] Launching the Windows-native Orkas via run.cmd so Windows IME works normally.
EOF
    exec cmd.exe /d /s /c "pushd \"$WIN_APP_DIR\" && run.cmd"
  fi
  cat >&2 <<'EOF'
[Orkas] WSL/WSLg detected, but cmd.exe/wslpath is unavailable.
[Orkas] On Windows, launch Orkas with run.cmd so Windows IME works normally.
EOF
  exit 1
fi

echo "[Orkas] Starting Orkas (global prod)"

wait_for_relaunch_owner() {
  local owner_pid="${ORKAS_RELAUNCH_OWNER_PID:-}"
  [ -n "$owner_pid" ] || return 0
  case "$owner_pid" in
    *[!0-9]*|'')
      echo "[Orkas] Invalid relaunch owner PID; refusing to start." >&2
      exit 1
      ;;
  esac
  if [ "$owner_pid" -eq "$$" ]; then
    echo "[Orkas] Relaunch owner PID resolves to the launcher itself; refusing to start." >&2
    exit 1
  fi
  local attempt=0
  while kill -0 "$owner_pid" >/dev/null 2>&1 && [ "$attempt" -lt 150 ]; do
    sleep 0.1
    attempt=$((attempt + 1))
  done
  if kill -0 "$owner_pid" >/dev/null 2>&1; then
    echo "[Orkas] Relaunch owner PID $owner_pid did not exit within 15 seconds; refusing to terminate unrelated processes." >&2
    exit 1
  fi
  unset ORKAS_RELAUNCH_OWNER_PID
}

wait_for_relaunch_owner

if ! command -v node >/dev/null 2>&1; then
  echo "[Orkas] Node.js 20+ is required to bootstrap the source checkout. Install Node.js, then run ./run.sh again." >&2
  exit 1
fi

node "$APP_DIR/scripts/stop-source-instance.cjs" --root "$APP_DIR"

if [ "$(uname -s)" = "Linux" ]; then
  node "$APP_DIR/scripts/verify-linux-source-dependencies.cjs" --host-only
fi

node "$APP_DIR/scripts/ensure-deps.cjs"
node "$APP_DIR/scripts/ensure-dev-dependencies.cjs"
# macOS source runs need the same connector callback declaration that electron-builder adds to
# packaged apps. This never starts a local server; it only registers the `orkas://` OS protocol.
node "$APP_DIR/scripts/prepare-source-protocol.cjs" || true

cd "$APP_DIR"

if [ "$(uname -s)" = "Darwin" ]; then
  APP_BUNDLE="$APP_DIR/node_modules/electron/dist/Orkas.app"
  if [ -d "$APP_BUNDLE" ]; then
    ARGS=("$APP_DIR")
    # Launch through LaunchServices so the patched app name/icon are used in source runs.
    exec open -W -n "$APP_BUNDLE" --args "${ARGS[@]}"
  fi
fi

# Chromium's GPU process can repeatedly print
# `EGL Driver message (Error) eglQueryDeviceAttribEXT: Bad attribute` on macOS.
# This is ANGLE fallback noise when probing driver attributes and has no
# functional impact. Filter only that stderr line; pass through everything else.
# If `unbuffer` is unavailable, default line buffering is fine (macOS bash built-in).
exec npm run start:electron 2> >(grep -v --line-buffered "EGL Driver message" >&2)
