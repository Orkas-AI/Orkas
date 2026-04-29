#!/bin/bash
# Orkas PC 启动器。放在 PC/ 下，脚本自身所在目录即 PC 根。
# 行为：每次运行都先 kill 旧实例，再启动新进程（前台）。
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "[Orkas] 找不到 $APP_DIR/package.json，请确认 PC/ 结构完整。" >&2
  exit 1
fi

node "$APP_DIR/scripts/ensure-deps.cjs"

cd "$APP_DIR"
pkill -9 -f "$APP_DIR/node_modules/electron/dist" >/dev/null 2>&1 || true
sleep 0.3
# Chromium GPU 进程在 macOS 上反复刷 `EGL Driver message (Error) eglQueryDeviceAttribEXT: Bad attribute`,
# 是 ANGLE 探测 EGL 属性时 macOS 驱动不识别的 fallback 噪音(无功能影响)。
# 走 process substitution 把这一类 stderr 过滤掉,其余日志原样透传。
# `unbuffer` 不可用时落到默认行缓冲(macOS bash 自带,无额外依赖)。
exec npm start 2> >(grep -v --line-buffered "EGL Driver message" >&2)
