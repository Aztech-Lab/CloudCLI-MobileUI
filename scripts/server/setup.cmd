@echo off
rem [local] Set up CloudCLI-MobileUI on this computer (see setup.ps1 for the options).
rem Double-click it, or run it from a terminal: setup.cmd [-Yes] [-NoAutostart] ...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set EXITCODE=%ERRORLEVEL%
rem Keep the window open when started by double-click.
echo %CMDCMDLINE% | find /i "%~nx0" >nul && pause
exit /b %EXITCODE%
