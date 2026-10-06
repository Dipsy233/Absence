@echo off
rem Convenience shortcut. The real desktop launcher lives with the desktop shell
rem under apps/desktop/, so the launchers are grouped by what they run. This
rem just forwards, so there is one implementation.
call "%~dp0apps\desktop\start-daze-app.bat" %*
