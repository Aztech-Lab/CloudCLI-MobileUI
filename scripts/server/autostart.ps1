# [local] Start CloudCLI-MobileUI when you log in to Windows (the live server, hidden).
#
#   .\autostart.ps1 on       add the entry (HKCU Run key; no admin needed)
#   .\autostart.ps1 off      remove it
#   .\autostart.ps1 status   on | off | disabled  (-Json for machine-readable output)
#
# The entry shows in Task Manager > Startup apps under the config's autostartName, where it
# can be switched off; status then says "disabled", and "on" here switches it back on.
[CmdletBinding()]
param(
    [Parameter(Position = 0)][ValidateSet('on', 'off', 'status')][string]$Action = 'status',
    [string]$Config = '',
    [string]$Name = '',
    [switch]$Json
)

. (Join-Path $PSScriptRoot '_common.ps1')
$cfg = Read-ServerConfig -Config $Config
if (-not $Name) { $Name = $cfg.autostartName }

if ($Action -eq 'on') {
    $startArgs = @('-Service')
    # The default config is found without help; any other one has to be named.
    $defaultConfig = Join-Path $script:CloneRoot '_server\config.json'
    if ($cfg.configPath -and ($cfg.configPath -ne $defaultConfig)) { $startArgs += @('-Config', $cfg.configPath) }
    $command = Get-HiddenScriptCommand (Join-Path $PSScriptRoot 'start.ps1') $startArgs
    New-Item -Path $script:RunKey -Force -ErrorAction SilentlyContinue | Out-Null
    New-ItemProperty -Path $script:RunKey -Name $Name -Value $command -PropertyType String -Force | Out-Null
    # Clear a "disabled in Task Manager" mark, so that "on" really means on.
    Remove-ItemProperty -Path $script:StartupApprovedKey -Name $Name -ErrorAction SilentlyContinue
} elseif ($Action -eq 'off') {
    Remove-ItemProperty -Path $script:RunKey -Name $Name -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $script:StartupApprovedKey -Name $Name -ErrorAction SilentlyContinue
}

$state = Get-AutostartState $Name
if ($Json) {
    Write-Output ($state | ConvertTo-Json -Compress)
} else {
    switch ($state.state) {
        'on' { Write-Host "Autostart is on: '$Name' starts CloudCLI when you log in." }
        'off' { Write-Host "Autostart is off." }
        'disabled' { Write-Host "Autostart is registered as '$Name' but switched off in Task Manager > Startup apps. '.\autostart.ps1 on' switches it back on." }
    }
}
if (($Action -eq 'on' -and $state.state -ne 'on') -or ($Action -eq 'off' -and $state.state -ne 'off')) { exit 1 }
exit 0
