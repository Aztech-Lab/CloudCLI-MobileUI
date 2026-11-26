# [local] Restart CloudCLI-MobileUI: stop -> (optionally activate a prepared build) -> start.
# Progress goes to <logs>\restart.log (restart-staging.log for the test portal).
#
#   .\restart.ps1                   restart now (asks first if work is running)
#   .\restart.ps1 -Deploy           also make <runtime>.next (from deploy) the running build;
#                                   the previous one is kept in the backups folder
#   .\restart.ps1 -Detach -Delay 30 run hidden and detached after 30 s. Use this whenever the
#                                   caller runs INSIDE the server (e.g. a chat in CloudCLI):
#                                   the restart then survives the server going down.
#   -Staging  restart the test portal instead; the live server is not touched.
#   -Force    do not ask about running work.   -Local  listen on 127.0.0.1 only.
[CmdletBinding()]
param(
    [int]$Delay = -1,
    [switch]$Deploy,
    [switch]$Staging,
    [switch]$Local,
    [int]$Port = 0,
    [switch]$Force,
    [switch]$Detach,
    [string]$Config = ''
)

. (Join-Path $PSScriptRoot '_common.ps1')
$instanceName = if ($Staging) { 'staging' } else { 'live' }
$cfg = Read-ServerConfig -Config $Config -Instance $instanceName -Port $Port
$inst = $cfg.instance
$Port = [int]$inst.port
if ($Delay -lt 0) { $Delay = if ($Detach) { 5 } else { 0 } }

if (-not $Force) {
    $health = Get-ServerHealth $cfg $instanceName
    if (-not (Confirm-ActiveWork $health -Action 'Restart')) { exit 2 }
}

if ($Detach) {
    $restartArgs = @('-Force', '-Delay', "$Delay") + (Get-PassThroughArgs $cfg -Staging:$Staging -Local:$Local)
    if ($Deploy) { $restartArgs += '-Deploy' }
    $processId = Start-DetachedScript $PSCommandPath $restartArgs
    if (-not $processId) { exit 1 }
    Write-Host "Restart of port $Port scheduled in $Delay s (detached, PID $processId). Progress: $($inst.restartLog)"
    exit 0
}

$log = New-Logger $inst.restartLog
& $log "restart requested (delay=${Delay}s, port=$Port, local=$Local, deploy=$Deploy)"
if ($Delay -gt 0) { Start-Sleep -Seconds $Delay }

if (-not (Stop-CloudCliOnPort -Port $Port -Log $log)) {
    & $log 'restart aborted'
    exit 1
}

if ($Deploy) {
    $result = Invoke-ServerCtl (@('activate', '--instance', $instanceName, '--port', "$Port") + (Get-ConfigArgs $cfg.configPath))
    if ($result.Code -ne 0) { & $log "ERROR: activating the new build failed (exit $($result.Code)); starting what is there" }
}

& $log "starting CloudCLI (log: $($inst.serverLog))"
$startArgs = @{ Port = $Port }
if ($Staging) { $startArgs.Staging = $true }
if ($Local) { $startArgs.Local = $true }
if ($cfg.configPath) { $startArgs.Config = $cfg.configPath }
& (Join-Path $PSScriptRoot 'start.ps1') @startArgs
$code = $LASTEXITCODE
& $log $(if ($code -eq 0) { 'restart done: server is up' } else { "ERROR: start failed (exit $code); see $($inst.serverLog)" })
exit $code
