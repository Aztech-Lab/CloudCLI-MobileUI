@echo off
rem [local] Runs stop.ps1 with the same arguments (see that file).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
