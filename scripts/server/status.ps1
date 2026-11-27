# [local] Show whether CloudCLI-MobileUI runs: PID, port, build, running work, autostart.
#
#   .\status.ps1            the live server        .\status.ps1 -Staging   the test portal
#   .\status.ps1 -Json      machine-readable (used by the settings page)
[CmdletBinding()]
param(
    [switch]$Staging,
    [switch]$Json,
    [int]$Port = 0,
    [string]$Config = ''
)

. (Join-Path $PSScriptRoot '_common.ps1')
$instanceName = if ($Staging) { 'staging' } else { 'live' }
$cfg = Read-ServerConfig -Config $Config -Instance $instanceName -Port $Port
$owner = Get-PortOwner ([int]$cfg.instance.port)
$autostart = if ($Staging) { 'n/a' } else { (Get-AutostartState $cfg.autostartName).state }

$arguments = @('status', '--instance', $instanceName, '--port', "$($cfg.instance.port)", '--autostart', $autostart,
    '--format', $(if ($Json) { 'json' } else { 'text' })) + (Get-ConfigArgs $cfg.configPath)
if ($owner.ServerPids.Count -gt 0) { $arguments += @('--pid', "$($owner.ServerPids[0])") }
if ($owner.ForeignPids.Count -gt 0) { $arguments += @('--foreign-pid', "$($owner.ForeignPids[0])") }
$result = Invoke-ServerCtl $arguments
Write-Output $result.Text
exit $result.Code
