@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title ABSENCE (desktop build)

rem ===========================================================================
rem  ABSENCE desktop build
rem
rem  One command that turns this checkout into a distributable desktop app.
rem  Every artifact lands under dist\desktop\:
rem
rem    dist\desktop\build\server.cjs      ABSENCE's server + core, compiled to one
rem                                       CJS file (no tsx needed at runtime)
rem    dist\desktop\build\node_modules    the server's production deps only,
rem                                       installed fresh for this platform
rem    dist\desktop\release\              electron-builder's output:
rem                                       the NSIS installer and win-unpacked\
rem                                       (a portable folder you can run
rem                                       directly, no installer)
rem
rem  Steps:
rem    1. web app          npm run build            -> dist\web
rem    2. server bundle    apps/desktop run bundle  -> dist\desktop\build\server.cjs
rem    3. server deps      apps/desktop run stage   -> dist\desktop\build\node_modules
rem    4. package          apps/desktop run dist    -> dist\desktop\release
rem
rem  Usage:
rem    start-absence-app.bat          full build and package
rem    start-absence-app.bat check    dry run - report what would happen, build nothing
rem    start-absence-app.bat pack     same as full build, but skip the installer
rem                                (electron-builder --dir, faster; output is
rem                                still dist\desktop\release\win-unpacked)
rem
rem  Env:
rem    ABSENCE_SKIP_WEB=1   reuse the existing dist\web build (faster iteration)
rem ===========================================================================

rem This script is at the repo root; resolve the absolute path.
pushd "%~dp0"
set "REPO=%CD%"
popd

set "DRY=0"
set "DIRONLY=0"
if /i "%~1"=="check" set "DRY=1"
if /i "%~1"=="pack"  set "DIRONLY=1"

echo ============================================================
echo   ABSENCE - desktop build
echo ------------------------------------------------------------
echo   repo    : %REPO%
echo   output  : %REPO%\dist\desktop
if "%DIRONLY%"=="1" echo   mode    : pack (no installer)
if "%DRY%"=="1"     echo   mode    : dry run - nothing will be built
echo ============================================================
echo.

pushd "%REPO%"

rem ---------------------------------------------------------- 0/4 deps
if not exist "node_modules" (
  echo [0/4] installing dependencies ... this happens only once
  if "%DRY%"=="1" (
    echo       dry run: would run npm install
  ) else (
    call npm install --no-audit --no-fund
    if errorlevel 1 goto fail
  )
) else (
  echo [0/4] dependencies present
)

rem The desktop shell carries its own node_modules (Electron + esbuild), so the
rem Windows build never picks up the Linux-built binaries from the root tree.
if not exist "apps\desktop\node_modules\electron" (
  echo       installing the desktop shell ^(electron^) ... this happens only once
  if "%DRY%"=="1" (
    echo       dry run: would run npm --prefix apps/desktop install
  ) else (
    call npm --prefix apps/desktop install --no-audit --no-fund
    if errorlevel 1 goto fail
  )
) else (
  echo       desktop shell present
)

rem ---------------------------------------------------------- 1/4 web app
if defined ABSENCE_SKIP_WEB if exist "dist\web\index.html" (
  echo [1/4] skipping the web build ^(ABSENCE_SKIP_WEB=1, dist\web present^)
  goto server_bundle
)
echo [1/4] building the web app ...
if "%DRY%"=="1" (
  echo       dry run: would run npm run build
) else (
  call npm run build
  if errorlevel 1 goto fail
)

:server_bundle
rem ---------------------------------------------------------- 2/4 server bundle
echo [2/4] bundling the server into dist\desktop\build\server.cjs ...
if "%DRY%"=="1" (
  echo       dry run: would run npm --prefix apps/desktop run bundle
) else (
  call npm --prefix apps/desktop run bundle
  if errorlevel 1 goto fail
)

rem ---------------------------------------------------------- 3/4 server deps
echo [3/4] staging the server's production dependencies ...
if "%DRY%"=="1" (
  echo       dry run: would run npm --prefix apps/desktop run stage
) else (
  call npm --prefix apps/desktop run stage
  if errorlevel 1 goto fail
)

rem ---------------------------------------------------------- 4/4 package
if "%DIRONLY%"=="1" (
  echo [4/4] packaging ^(folder only, no installer^) ...
  if "%DRY%"=="1" (
    echo       dry run: would run npm --prefix apps/desktop run pack
  ) else (
    call npm --prefix apps/desktop run pack
    if errorlevel 1 goto fail
  )
) else (
  echo [4/4] packaging ^(NSIS installer^) ...
  if "%DRY%"=="1" (
    echo       dry run: would run npm --prefix apps/desktop run dist
  ) else (
    call npm --prefix apps/desktop run dist
    if errorlevel 1 goto fail
  )
)

echo.
echo ============================================================
echo   done - artifacts under dist\desktop:
echo     build\server.cjs              the compiled server
echo     build\node_modules            its production dependencies
if "%DIRONLY%"=="1" (
echo     release\win-unpacked          the portable app folder
) else (
echo     release\                      the installer + win-unpacked
)
echo ============================================================

popd
endlocal
exit /b 0

:fail
echo.
echo ABSENCE desktop build failed. See the messages above.
popd
endlocal
pause
exit /b 1
