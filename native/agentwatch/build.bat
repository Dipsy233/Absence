@echo off
REM Build the Windows process observer. Committed prebuilt (agentwatch.exe),
REM so end users never run this; rebuild it whenever agentwatch.c changes.
REM
REM Skips the build entirely when agentwatch.exe is already newer than every
REM source file, so a repeat invocation is cheap. Pass --force to rebuild.
REM
REM MinGW is preferred because it is what the development machine has.
REM Falls back to MSVC if cl.exe is on PATH.

setlocal
cd /d "%~dp0"

rem ------------------------------------------------- skip when up to date
if /i "%~1"=="--force" goto build
if not exist "agentwatch.exe" goto build
rem Build only if a source file is newer than the output. PowerShell compares
rem the timestamps; a missing compiler-independent check keeps this portable.
powershell -NoProfile -Command ^
  "$out = Get-Item -LiteralPath 'agentwatch.exe';" ^
  "$src = Get-ChildItem -Path *.c,*.h -File -ErrorAction SilentlyContinue;" ^
  "if ($src | Where-Object { $_.LastWriteTimeUtc -gt $out.LastWriteTimeUtc }) { exit 1 } else { exit 0 }" >nul 2>&1
if not errorlevel 1 (
  echo agentwatch.exe is up to date - skipping ^(use --force to rebuild^)
  exit /b 0
)

:build

where g++ >nul 2>nul
if %errorlevel%==0 (
  echo Building agentwatch.exe with MinGW...
  g++ -O2 -municode -o agentwatch.exe agentwatch.c -lntdll
  if %errorlevel%==0 ( echo OK & exit /b 0 )
  echo MinGW build failed.
)

where cl >nul 2>nul
if %errorlevel%==0 (
  echo Building agentwatch.exe with MSVC...
  cl /nologo /O2 /W4 /DWIN32_LEAN_AND_MEAN agentwatch.c /link ntdll.lib
  if exist agentwatch.obj del agentwatch.obj
  if %errorlevel%==0 ( echo OK & exit /b 0 )
  echo MSVC build failed.
)

echo No C++ compiler found ^(need g++ or cl^).
exit /b 1
