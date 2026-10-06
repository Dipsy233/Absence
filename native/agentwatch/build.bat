@echo off
REM Build the Windows process observer. Committed prebuilt (agentwatch.exe),
REM so end users never run this; rebuild it whenever agentwatch.c changes.
REM
REM MinGW is preferred because it is what the development machine has.
REM Falls back to MSVC if cl.exe is on PATH.

setlocal
cd /d "%~dp0"

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
