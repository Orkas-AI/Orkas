#!/bin/bash
# Orkas launcher. Lives at the repo root; the script's own dir is the app root.
# Behavior: kills any prior instance, then starts a new one in the foreground.
#
# OSS build is locked to the overseas Orkas server (orkas.ai). The profile is
# pinned here so a stray `ORKAS_PROFILE` in the user's shell can't accidentally
# route to a different region. To point at a self-hosted dev server, override
# the base URL directly:
#   ORKAS_API_BASE_URL=http://127.0.0.1:8888/api ./run.sh
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "[Orkas] $APP_DIR/package.json not found; check the working directory." >&2
  exit 1
fi

export ORKAS_PROFILE=global

node "$APP_DIR/scripts/ensure-deps.cjs"

cd "$APP_DIR"
pkill -9 -f "$APP_DIR/node_modules/electron/dist" >/dev/null 2>&1 || true
sleep 0.3
# Chromium GPU 进程在 macOS 上反复刷 `EGL Driver message (Error) eglQueryDeviceAttribEXT: Bad attribute`,
# 是 ANGLE 探测 EGL 属性时 macOS 驱动不识别的 fallback 噪音(无功能影响)。
# 走 process substitution 把这一类 stderr 过滤掉,其余日志原样透传。
# `unbuffer` 不可用时落到默认行缓冲(macOS bash 自带,无额外依赖)。
exec npm start 2> >(grep -v --line-buffered "EGL Driver message" >&2)
