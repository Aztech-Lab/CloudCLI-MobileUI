@echo off
rem [local] Runs status.ps1 with the same arguments (see that file).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0status.ps1" %*
