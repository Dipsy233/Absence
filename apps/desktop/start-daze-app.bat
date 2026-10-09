@echo off
rem Convenience shortcut. The desktop build lives with the desktop shell's
rem tooling; this just forwards, so there is one implementation at the root.
rem
rem   start-daze-app.bat          build and package  -> dist\desktop\release
rem   start-daze-app.bat pack     folder only, no installer
rem   start-daze-app.bat check    dry run
call "%~dp0start-daze-app.bat" %*
