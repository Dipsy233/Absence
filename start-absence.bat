@echo off
rem Convenience shortcut. The real browser launcher lives with the other
rem browser-only files under scripts/browser/, so the launchers are grouped by
rem what they run. This just forwards, so there is one implementation.
call "%~dp0scripts\browser\start-absence.bat" %*
