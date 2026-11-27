@echo off
rem [local] Runs start.ps1 with the same arguments (see that file).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
