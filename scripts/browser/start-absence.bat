@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title ABSENCE launcher

rem ===========================================================================
rem  ABSENCE one-click launcher
rem
rem  Builds the web app and starts the ABSENCE server, then opens the UI. There is
rem  no local model server any more: Pi supplies the model, so ABSENCE needs no
rem  separate inference process.
rem
rem  The web app is ALWAYS rebuilt. The frontend is compiled into dist/web at
rem  the repo root, and the server only serves that directory — so a stale
rem  dist is what you would otherwise see, no matter what changed in src.
rem
rem  This launcher lives under scripts/browser/, but always operates on the
rem  repo root (two levels up).
rem
rem  Usage:
rem    scripts\browser\start-absence.bat            build and start
rem    scripts\browser\start-absence.bat check      dry run: report what would happen, start nothing
rem
rem  Override by setting before running:
rem    ABSENCE_PORT    (default 8848)
rem    ABSENCE_AGENT   (default pi)
rem ===========================================================================

rem This script is scripts/browser → the repo root is two levels up.
set "REPO=%~dp0..\.."
pushd "%REPO%"
set "REPO=%CD%"
popd

if not defined ABSENCE_PORT set "ABSENCE_PORT=8848"
if not defined ABSENCE_AGENT set "ABSENCE_AGENT=pi"

set "ABSENCE_URL=http://127.0.0.1:%ABSENCE_PORT%/api/projects"

set "DRY=0"
if /i "%~1"=="check" set "DRY=1"
if /i "%~2"=="check" set "DRY=1"

where curl >nul 2>&1
if errorlevel 1 (set "HAVE_CURL=0") else (set "HAVE_CURL=1")

echo ============================================================
echo   ABSENCE
echo ------------------------------------------------------------
echo   repo   : %REPO%
echo   agent  : %ABSENCE_AGENT%
echo   absence   : port %ABSENCE_PORT%
if "%DRY%"=="1" echo   mode   : dry run - nothing will be started
echo ============================================================
echo.

pushd "%REPO%"

rem ------------------------------------------------------------ 1/2 install
if not exist "node_modules" (
  echo [1/2] installing dependencies ... this happens only once
  if "%DRY%"=="1" (
    echo       dry run: would run npm install
  ) else (
    call npm install --no-audit --no-fund
    if errorlevel 1 goto fail
  )
) else (
  echo [1/2] dependencies present
)

rem -------------------------------------------------------------- 2/2 build
echo [2/2] building web app ...
if "%DRY%"=="1" (
  echo       dry run: would run npm run build
) else (
  call npm run build
  if errorlevel 1 goto fail
)

popd

rem --------------------------------------------------------------- server
call :http_ok "%ABSENCE_URL%"
if not errorlevel 1 goto absence_ready

echo [run] starting ABSENCE server ... agent=%ABSENCE_AGENT%
if "%DRY%"=="1" (
  echo       dry run: would run npm start with ABSENCE_AGENT=%ABSENCE_AGENT%
  goto absence_done
)
set "ABSENCE_AGENT=%ABSENCE_AGENT%"
pushd "%REPO%"
start "ABSENCE server" cmd /c "npm start"
popd
call :wait_http "%ABSENCE_URL%" 60 "absence server"
goto absence_done

:absence_ready
echo [run] ABSENCE already running on port %ABSENCE_PORT%

:absence_done

echo.
echo ============================================================
echo   open   : http://localhost:%ABSENCE_PORT%
echo ============================================================
echo.

if "%DRY%"=="1" (
  echo Dry run complete.
  exit /b 0
)

echo Opening the browser. Close the "ABSENCE server" window to stop everything.
start "" "http://localhost:%ABSENCE_PORT%"
echo.
pause >nul
exit /b 0

rem ======================================================== helpers ========

:fail
echo.
echo Launch failed - see the messages above.
popd
pause
exit /b 1

:http_ok
if "%HAVE_CURL%"=="1" goto http_curl
powershell -NoProfile -Command "if (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 '%~1' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:http_curl
curl -fsS -m 3 -o NUL "%~1" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:wait_http
set "WURL=%~1"
set /a WTRIES=%~2
:wait_loop
call :http_ok "%WURL%"
if not errorlevel 1 (
  echo       ready: %~3
  exit /b 0
)
set /a WTRIES-=1
if %WTRIES% leq 0 (
  echo       timed out waiting for %~3
  exit /b 1
)
ping -n 2 127.0.0.1 >nul 2>&1
goto wait_loop
