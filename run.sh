#!/bin/bash
# Orkas PC launcher. Lives under PC/; the script's own directory is the PC root.
# Behavior: kills any prior instance, then starts a new one in the foreground.
#
# Usage (matches Server `env/start/{dev_,}api_start.sh` profile mode; see Server CLAUDE.md §7):
#   ./run.sh                # profile=global  (default, overseas orkas.ai)
#   ./run.sh cn             # profile=cn      (CN orkas.work)
#   ORKAS_PROFILE=global ./run.sh    # env style remains supported
# Profile is passed to the main process through ORKAS_PROFILE and read by
# features/marketplace.ts::apiBase() and related resolvers. Local dev can still
# point to a custom server explicitly:
# ORKAS_API_BASE_URL=http://localhost:8888/api ./run.sh.
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

# Priority: positional $1 > ORKAS_PROFILE env > default global
export ORKAS_PROFILE="${1:-${ORKAS_PROFILE:-global}}"
echo "[Orkas] Starting profile=$ORKAS_PROFILE"

node "$APP_DIR/scripts/ensure-deps.cjs"

cd "$APP_DIR"
pkill -9 -f "$APP_DIR/node_modules/electron/dist" >/dev/null 2>&1 || true
sleep 0.3

if [ "$(uname -s)" = "Darwin" ]; then
  APP_BUNDLE="$APP_DIR/node_modules/electron/dist/Orkas.app"
  if [ -d "$APP_BUNDLE" ]; then
    ARGS=("$APP_DIR" "--orkas-profile=$ORKAS_PROFILE")
    if [ -n "${ORKAS_API_BASE_URL:-}" ]; then
      ARGS+=("--orkas-api-base-url=$ORKAS_API_BASE_URL")
    fi
    if [ -n "${ORKAS_VOICE_API_BASE:-}" ]; then
      ARGS+=("--orkas-voice-api-base=$ORKAS_VOICE_API_BASE")
    fi
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
exec npm start 2> >(grep -v --line-buffered "EGL Driver message" >&2)
