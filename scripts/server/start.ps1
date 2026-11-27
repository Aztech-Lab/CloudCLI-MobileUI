# [local] Start CloudCLI-MobileUI from the deployed runtime (see config.template.jsonc).
#
#   .\start.ps1               start in the background (hidden), log to <logs>\cloudcli.log
#   .\start.ps1 -Foreground   run in this window (Ctrl+C stops it)
#   .\start.ps1 -Local        listen on 127.0.0.1 only, whatever the config says
#   .\start.ps1 -Staging      the test portal (stagingPort, its own build and database copy)
#
# -Service is the hidden background process itself (used by the background start and by
# autostart): it runs the server and appends its output to the log.
[CmdletBinding()]
param(
    [switch]$Staging,
    [switch]$Local,
    [int]$Port = 0,
    [switch]$Foreground,
    [switch]$Service,
    [string]$Config = '',
    [int]$WaitSeconds = 90
)

. (Join-Path $PSScriptRoot '_common.ps1')
$instanceName = if ($Staging) { 'staging' } else { 'live' }
$cfg = Read-ServerConfig -Config $Config -Instance $instanceName -Port $Port
$inst = $cfg.instance
$Port = [int]$inst.port

if (-not (Test-Path -LiteralPath $inst.cli)) {
    Write-Host "No build to run at $($inst.runtime)."
    Write-Host 'Run setup.ps1, or deploy a build and activate it with restart.ps1 -Deploy.'
    exit 1
}

$owner = Get-PortOwner $Port
if ($owner.ServerPids.Count -gt 0) {
    Write-Host "CloudCLI is already running on port $Port (PID $($owner.ServerPids -join ', '))."
    exit 0
}
if ($owner.ForeignPids.Count -gt 0) {
    Write-Host "Port $Port is in use by PID $($owner.ForeignPids -join ', ') ($($owner.ForeignNames -join ', ')); not starting."
    exit 1
}

if ($Foreground -or $Service) {
    $envArgs = @('env', '--instance', $instanceName, '--port', "$Port") + (Get-ConfigArgs $cfg.configPath)
    if ($Local) { $envArgs += '--local' }
    $result = Invoke-ServerCtl $envArgs
    if ($result.Code -ne 0) { exit 1 }
    $environment = $result.Text | ConvertFrom-Json
    foreach ($name in $environment.unset) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    foreach ($entry in $environment.set.PSObject.Properties) { Set-Item -LiteralPath "Env:$($entry.Name)" -Value $entry.Value }

    $label = if ($Staging) { 'CloudCLI-MobileUI TEST' } else { 'CloudCLI-MobileUI' }
    $buildFile = Join-Path $inst.runtime '.build.json'
    if (Test-Path -LiteralPath $buildFile) {
        try { $b = Get-Content -LiteralPath $buildFile -Raw | ConvertFrom-Json; $label += " $($b.branch) $($b.commit)" } catch { }
    }
    $node = Get-NodeExe
    # Not the runtime folder: a process whose working folder is inside it would keep Windows
    # from swapping in a new build there.
    Set-Location -LiteralPath $HOME

    if ($Service) {
        $serverLog = $inst.serverLog
        New-Item -ItemType Directory -Force (Split-Path -Parent $serverLog) | Out-Null
        # Keep the log from growing without bound: one previous file is kept.
        $existing = Get-Item -LiteralPath $serverLog -ErrorAction SilentlyContinue
        if ($existing -and $existing.Length -gt 20MB) { Move-Item -LiteralPath $serverLog -Destination "$serverLog.1" -Force }
        "===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') start: $label on $($env:HOST):$Port =====" |
            Add-Content -Encoding utf8 -LiteralPath $serverLog
        & $node $inst.cli start --port $Port *>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath $serverLog -Append -Encoding utf8
        $code = $LASTEXITCODE
        "===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') exited (code $code) =====" | Add-Content -Encoding utf8 -LiteralPath $serverLog
        exit $code
    }

    Write-Host "$label -> http://$($env:HOST):$Port  (Ctrl+C to stop)"
    & $node $inst.cli start --port $Port
    exit $LASTEXITCODE
}

# Background: a hidden, detached copy of this script in -Service mode runs the server.
$serviceArgs = @('-Service') + (Get-PassThroughArgs $cfg -Staging:$Staging -Local:$Local)
$processId = Start-DetachedScript $PSCommandPath $serviceArgs
if (-not $processId) { exit 1 }
Write-Host "Starting CloudCLI on port $Port in the background (log: $($inst.serverLog)) ..."
$wait = Invoke-ServerCtl (@('wait-health', '--instance', $instanceName, '--port', "$Port", '--timeout', "$WaitSeconds") + (Get-ConfigArgs $cfg.configPath))
if ($wait.Code -ne 0) {
    Write-Host "The server did not answer within $WaitSeconds s. See $($inst.serverLog)."
    exit 1
}
$owner = Get-PortOwner $Port
$shownHost = if ($Local -or $cfg.listenAddress -eq '127.0.0.1') { '127.0.0.1' } else { '<this computer''s address>' }
Write-Host "CloudCLI is running (PID $($owner.ServerPids -join ', ')): http://127.0.0.1:$Port on this computer$(if ($shownHost -ne '127.0.0.1') { ", http://${shownHost}:$Port from allowed networks" })."
exit 0
