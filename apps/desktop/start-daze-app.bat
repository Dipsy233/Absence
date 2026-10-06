@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title DAZE (desktop)

rem ===========================================================================
rem  DAZE desktop launcher
rem
rem  Starts DAZE as a native window: the server runs *inside* the Electron main
rem  process and the UI is the same built web app, so there is no browser and no
rem  port to choose. Closing the window keeps it in the tray (observation keeps
rem  running); quit from the tray menu or Ctrl+Q.
rem
rem  This launcher lives with the desktop shell, under apps/desktop/. The
rem  browser launcher (scripts/browser/start-daze.bat) stays for development and
rem  for the WSL/eBPF workflow.
rem
rem  Usage:
rem    apps\desktop\start-daze-app.bat          build the web app, then open the window
rem    apps\desktop\start-daze-app.bat check    dry run - report what would happen
rem
rem  Env:
rem    DAZE_AGENT   (default pi)   runtime: pi or mock
rem ===========================================================================

rem This script is apps/desktop → the repo root is two levels up.
set "REPO=%~dp0..\.."
pushd "%REPO%"
set "REPO=%CD%"
popd
if not defined DAZE_AGENT set "DAZE_AGENT=pi"

set "DRY=0"
if /i "%~1"=="check" set "DRY=1"

echo ============================================================
echo   DAZE - desktop shell
echo ------------------------------------------------------------
echo   repo   : %REPO%
echo   agent  : %DAZE_AGENT%
if "%DRY%"=="1" echo   mode   : dry run - nothing will be started
echo ============================================================
echo.

pushd "%REPO%"

rem ---------------------------------------------------------- 1/3 deps
if not exist "node_modules" (
  echo [1/3] installing dependencies ... this happens only once
  if "%DRY%"=="1" (
    echo       dry run: would run npm install
  ) else (
    call npm install --no-audit --no-fund
    if errorlevel 1 goto fail
  )
) else (
  echo [1/3] dependencies present
)

rem ---------------------------------------------------------- 2/3 build web
echo [2/3] building the web app ...
if "%DRY%"=="1" (
  echo       dry run: would run npm run build
) else (
  call npm run build
  if errorlevel 1 goto fail
)

rem ---------------------------------------------------------- 3/3 desktop
if not exist "apps\desktop\node_modules\electron" (
  echo [3/3] installing the desktop shell ^(electron^) ... this happens only once
  if "%DRY%"=="1" (
    echo       dry run: would run npm --prefix apps/desktop install
  ) else (
    call npm --prefix apps/desktop install --no-audit --no-fund
    if errorlevel 1 goto fail
  )
) else (
  echo [3/3] desktop shell present
)

echo.
echo starting DAZE as a native window ...
if "%DRY%"=="1" (
  echo       dry run: would run npm --prefix apps/desktop start
) else (
  set "DAZE_AGENT=%DAZE_AGENT%"
  call npm --prefix apps/desktop start
  if errorlevel 1 goto fail
)

popd
endlocal
exit /b 0

:fail
echo.
echo DAZE failed to start. See the messages above.
popd
endlocal
pause
exit /b 1
