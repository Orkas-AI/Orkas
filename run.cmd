@echo off
REM Windows counterpart of run.sh. Stop the old Electron process before
REM starting a fresh development instance.
setlocal EnableExtensions EnableDelayedExpansion
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

if not exist "%APP_DIR%\package.json" (
  echo [Orkas] %APP_DIR%\package.json not found; check the project directory layout. 1>&2
  exit /b 1
)

echo [Orkas] Starting Orkas

node --version >nul 2>nul
if errorlevel 1 (
  echo [Orkas] Node.js is unavailable; preparing the pinned bundled runtime...
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\bootstrap-node.ps1"
  if errorlevel 1 exit /b 1
  set "RUNTIME_KEY=win32-x64"
  if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "RUNTIME_KEY=win32-arm64"
  if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "RUNTIME_KEY=win32-arm64"
  set "PATH=%APP_DIR%\resources\runtime\node\!RUNTIME_KEY!;%PATH%"
)
node --version >nul 2>nul
if errorlevel 1 (
  echo [Orkas] Node.js is still unavailable after bootstrap. 1>&2
  exit /b 1
)

call node "%APP_DIR%\scripts\ensure-deps.cjs"
if errorlevel 1 exit /b 1
call node "%APP_DIR%\scripts\ensure-dev-dependencies.cjs"
if errorlevel 1 exit /b 1

pushd "%APP_DIR%"
taskkill /F /IM electron.exe >nul 2>nul
call npm run start:electron
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%
