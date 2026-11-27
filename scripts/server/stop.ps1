# [local] Stop CloudCLI-MobileUI: only the CloudCLI server listening on the configured port;
# refuses when another program holds the port. Asks first if work is running.
#
#   .\stop.ps1                    stop the live server
#   .\stop.ps1 -Staging           stop the test portal
#   .\stop.ps1 -Force             do not ask about running work
#   .\stop.ps1 -Detach -Delay 5   run hidden and detached (when called from inside the server)
[CmdletBinding()]
param(
    [switch]$Staging,
    [int]$Port = 0,
    [switch]$Force,
    [switch]$Detach,
    [int]$Delay = -1,
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
    if (-not (Confirm-ActiveWork $health -Action 'Stop')) { exit 2 }
}

if ($Detach) {
    $stopArgs = @('-Force', '-Delay', "$Delay") + (Get-PassThroughArgs $cfg -Staging:$Staging)
    $processId = Start-DetachedScript $PSCommandPath $stopArgs
    if (-not $processId) { exit 1 }
    Write-Host "Stop of port $Port scheduled in $Delay s (detached, PID $processId). Log: $($inst.restartLog)"
    exit 0
}

$log = New-Logger $inst.restartLog
& $log "stop requested (delay=${Delay}s, port=$Port)"
if ($Delay -gt 0) { Start-Sleep -Seconds $Delay }
if (Stop-CloudCliOnPort -Port $Port -Log $log) {
    & $log 'stopped'
    exit 0
}
exit 1
