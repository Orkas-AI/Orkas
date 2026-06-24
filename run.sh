#!/bin/bash
# Orkas PC launcher. Lives under PC/; the script's own directory is the PC root.
# Behavior: kills any prior instance, then starts a new one in the foreground.
#
# Usage:
#   ./run.sh
#
# Orkas source builds use exactly one server environment: global prod.
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "[Orkas] $APP_DIR/package.json not found; check the PC/ directory layout." >&2
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

node "$APP_DIR/scripts/ensure-deps.cjs"
node "$APP_DIR/bin/ensure-runtime.cjs" --root "$APP_DIR/resources/runtime"
node "$APP_DIR/scripts/fetch-officecli.cjs"

cd "$APP_DIR"
pkill -9 -f "$APP_DIR/node_modules/electron/dist" >/dev/null 2>&1 || true
sleep 0.3

# Keep the Orkas product identity and install data root unchanged, but give
# source launches their own Electron profile. Without this, a packaged Orkas
# instance that is already running owns the same Electron single-instance lock
# and this checkout exits before app.whenReady().
PROFILE_KEY="$(printf '%s' "$APP_DIR" | cksum | awk '{print $1}')"
ELECTRON_USER_DATA_DIR="${TMPDIR:-/tmp}/orkas-electron-source-$PROFILE_KEY"

if [ "$(uname -s)" = "Darwin" ]; then
  APP_BUNDLE="$APP_DIR/node_modules/electron/dist/Orkas.app"
  if [ -d "$APP_BUNDLE" ]; then
    ARGS=("--user-data-dir=$ELECTRON_USER_DATA_DIR" "$APP_DIR")
    # Launch through LaunchServices so macOS routes orkas:// open-url events to this dev app
    # instance. Directly executing `Electron .` leaves the app running, but protocol callbacks
    # may be delivered to the .app bundle instead of the command-line process.
    exec open -W -n "$APP_BUNDLE" --args "${ARGS[@]}"
  fi
fi

# Chromium's GPU process can repeatedly print
# `EGL Driver message (Error) eglQueryDeviceAttribEXT: Bad attribute` on macOS.
# This is ANGLE fallback noise when probing driver attributes and has no
# functional impact. Filter only that stderr line; pass through everything else.
# If `unbuffer` is unavailable, default line buffering is fine (macOS bash built-in).
if [ -x "$APP_DIR/node_modules/.bin/electron" ]; then
  exec "$APP_DIR/node_modules/.bin/electron" "--user-data-dir=$ELECTRON_USER_DATA_DIR" "$APP_DIR" 2> >(grep -v --line-buffered "EGL Driver message" >&2)
fi
exec npm start 2> >(grep -v --line-buffered "EGL Driver message" >&2)
