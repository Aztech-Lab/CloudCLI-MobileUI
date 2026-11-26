@echo off
rem [local] Runs restart.ps1 with the same arguments (see that file).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart.ps1" %*
