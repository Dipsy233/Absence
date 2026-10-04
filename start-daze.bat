@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title DAZE launcher

rem ===========================================================================
rem  DAZE one-click launcher
rem
rem  Starts the local model server, then the DAZE server, then opens the UI.
rem
rem  Usage:
rem    start-daze.bat            start everything
rem    start-daze.bat rebuild    force a web rebuild first
rem    start-daze.bat check      dry run: report what is up, start nothing
rem
rem  Override any of these by setting them before running:
rem    DAZE_MODEL_DIR  (default E:\0down\ml\qwen3-4B)
rem    DAZE_MODEL_PORT (default 8000)
rem    DAZE_PORT       (default 8787)
rem    DAZE_AGENT      (default: pi if the model is up, else mock)
rem ===========================================================================

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

if not defined DAZE_MODEL_DIR set "DAZE_MODEL_DIR=E:\0down\ml\qwen3-4B"
if not defined DAZE_MODEL_PORT set "DAZE_MODEL_PORT=8000"
if not defined DAZE_PORT set "DAZE_PORT=8787"

set "MODEL_URL=http://127.0.0.1:%DAZE_MODEL_PORT%/v1/models"
set "DAZE_URL=http://127.0.0.1:%DAZE_PORT%/api/projects"

set "DRY=0"
set "REBUILD=0"
if /i "%~1"=="check" set "DRY=1"
if /i "%~2"=="check" set "DRY=1"
if /i "%~1"=="rebuild" set "REBUILD=1"
if /i "%~2"=="rebuild" set "REBUILD=1"

where curl >nul 2>&1
if errorlevel 1 (set "HAVE_CURL=0") else (set "HAVE_CURL=1")

echo ============================================================
echo   DAZE
echo ------------------------------------------------------------
echo   repo   : %REPO%
echo   model  : %DAZE_MODEL_DIR%   port %DAZE_MODEL_PORT%
echo   daze   : port %DAZE_PORT%
if "%DRY%"=="1" echo   mode   : dry run - nothing will be started
echo ============================================================
echo.

rem ---------------------------------------------------------------- 1/3 model
set "MODEL_UP=0"
call :http_ok "%MODEL_URL%"
if not errorlevel 1 goto model_ready

if not exist "%DAZE_MODEL_DIR%\serve_qwen.bat" goto model_missing

echo [1/3] starting local model server ... first load takes about 20s
if "%DRY%"=="1" (
  echo       dry run: would start "%DAZE_MODEL_DIR%\serve_qwen.bat" --port %DAZE_MODEL_PORT%
  goto model_missing
)
pushd "%DAZE_MODEL_DIR%"
start "DAZE model" cmd /c "serve_qwen.bat --port %DAZE_MODEL_PORT%"
popd
call :wait_http "%MODEL_URL%" 180 "local model"
if not errorlevel 1 set "MODEL_UP=1"
goto model_done

:model_ready
echo [1/3] local model already running on port %DAZE_MODEL_PORT%
set "MODEL_UP=1"
goto model_done

:model_missing
echo [1/3] WARNING: local model not available - DAZE will fall back to the mock runtime

:model_done

rem ------------------------------------------------------------ 2/3 build web
set "NEED_BUILD=0"
if "%REBUILD%"=="1" set "NEED_BUILD=1"
if not exist "%REPO%\apps\web\dist\index.html" set "NEED_BUILD=1"

pushd "%REPO%"

if not exist "node_modules" (
  echo [2/3] installing dependencies ... this happens only once
  if "%DRY%"=="1" (
    echo       dry run: would run npm install
  ) else (
    call npm install --no-audit --no-fund
    if errorlevel 1 goto fail
  )
)

if "%NEED_BUILD%"=="1" (
  echo [2/3] building web app ...
  if "%DRY%"=="1" (
    echo       dry run: would run npm run build
  ) else (
    call npm run build
    if errorlevel 1 goto fail
  )
) else (
  echo [2/3] web build present - pass "rebuild" to force
)

popd

rem --------------------------------------------------------------- 3/3 server
if not defined AGENT (
  if "%MODEL_UP%"=="1" (set "AGENT=pi") else (set "AGENT=mock")
)

call :http_ok "%DAZE_URL%"
if not errorlevel 1 goto daze_ready

echo [3/3] starting DAZE server ... agent=%AGENT%
if "%DRY%"=="1" (
  echo       dry run: would run npm start with DAZE_AGENT=%AGENT%
  goto daze_done
)
set "DAZE_AGENT=%AGENT%"
pushd "%REPO%"
start "DAZE server" cmd /c "npm start"
popd
call :wait_http "%DAZE_URL%" 60 "daze server"
goto daze_done

:daze_ready
echo [3/3] DAZE already running on port %DAZE_PORT%

:daze_done

echo.
echo ============================================================
if "%MODEL_UP%"=="1" (
  echo   model  : http://127.0.0.1:%DAZE_MODEL_PORT%
) else (
  echo   model  : mock runtime
)
echo   open   : http://localhost:%DAZE_PORT%
echo ============================================================
echo.

if "%DRY%"=="1" (
  echo Dry run complete.
  exit /b 0
)

echo Opening the browser. Close the "DAZE model" and "DAZE server"
echo windows to stop everything.
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
