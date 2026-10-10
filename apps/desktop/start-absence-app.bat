@echo off
rem Convenience shortcut. The desktop build lives with the desktop shell's
rem tooling; this just forwards, so there is one implementation at the root.
rem
rem   start-absence-app.bat          build and package  -> dist\desktop\release
rem   start-absence-app.bat pack     folder only, no installer
rem   start-absence-app.bat check    dry run
call "%~dp0start-absence-app.bat" %*
