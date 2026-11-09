@echo off
rem One-time setup: copies the NABARD job to this PC's app data and schedules it every 6 hours.
set "DIR=%LOCALAPPDATA%\rrmohite-nabard"
if not exist "%DIR%" mkdir "%DIR%"
copy /y "%~dp0nabard-from-india.cmd" "%DIR%\run.cmd" >nul
> "%DIR%\run-hidden.vbs" echo CreateObject("WScript.Shell").Run """%DIR%\run.cmd""", 0, False
schtasks /create /f /tn "rrmohite NABARD updates" /sc hourly /mo 6 /tr "wscript.exe \"%DIR%\run-hidden.vbs\"" >nul && echo Scheduled: rrmohite NABARD updates, every 6 hours.
