@echo off
REM Orkas PC 启动器（Windows cmd 版；对应 run.sh）。
REM 行为：每次运行都先 kill 旧 electron，再启动新进程。
setlocal
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

if not exist "%APP_DIR%\package.json" (
  echo [Orkas] 找不到 %APP_DIR%\package.json，请确认 PC\ 结构完整。 1>&2
  exit /b 1
)

echo [Orkas] 启动 Orkas (global prod)

call node "%APP_DIR%\scripts\ensure-deps.cjs"
if errorlevel 1 exit /b 1
call node "%APP_DIR%\bin\ensure-runtime.cjs" --root "%APP_DIR%\resources\runtime"
if errorlevel 1 exit /b 1

pushd "%APP_DIR%"
taskkill /F /IM electron.exe >nul 2>nul
call npm start
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%
