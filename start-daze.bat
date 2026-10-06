@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title DAZE launcher

rem ===========================================================================
rem  DAZE one-click launcher
rem
rem  Builds the web app and starts the DAZE server, then opens the UI. There is
rem  no local model server any more: Pi supplies the model, so DAZE needs no
rem  separate inference process.
rem
rem  The web app is ALWAYS rebuilt. The frontend is compiled into
rem  apps/web/dist, and the server only serves that directory — so a stale
rem  dist is what you would otherwise see, no matter what changed in src.
rem
rem  Usage:
rem    start-daze.bat            build and start
rem    start-daze.bat check      dry run: report what would happen, start nothing
rem
rem  Override by setting before running:
rem    DAZE_PORT    (default 8848)
rem    DAZE_AGENT   (default pi)
rem ===========================================================================

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

if not defined DAZE_PORT set "DAZE_PORT=8848"
if not defined DAZE_AGENT set "DAZE_AGENT=pi"

set "DAZE_URL=http://127.0.0.1:%DAZE_PORT%/api/projects"

set "DRY=0"
if /i "%~1"=="check" set "DRY=1"
if /i "%~2"=="check" set "DRY=1"

where curl >nul 2>&1
if errorlevel 1 (set "HAVE_CURL=0") else (set "HAVE_CURL=1")

echo ============================================================
echo   DAZE
echo ------------------------------------------------------------
echo   repo   : %REPO%
echo   agent  : %DAZE_AGENT%
echo   daze   : port %DAZE_PORT%
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
call :http_ok "%DAZE_URL%"
if not errorlevel 1 goto daze_ready

echo [run] starting DAZE server ... agent=%DAZE_AGENT%
if "%DRY%"=="1" (
  echo       dry run: would run npm start with DAZE_AGENT=%DAZE_AGENT%
  goto daze_done
)
set "DAZE_AGENT=%DAZE_AGENT%"
pushd "%REPO%"
start "DAZE server" cmd /c "npm start"
popd
call :wait_http "%DAZE_URL%" 60 "daze server"
goto daze_done

:daze_ready
echo [run] DAZE already running on port %DAZE_PORT%

:daze_done

echo.
echo ============================================================
echo   open   : http://localhost:%DAZE_PORT%
echo ============================================================
echo.

if "%DRY%"=="1" (
  echo Dry run complete.
  exit /b 0
)

echo Opening the browser. Close the "DAZE server" window to stop everything.
start "" "http://localhost:%DAZE_PORT%"
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
