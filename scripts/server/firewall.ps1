# [local] Limit who can reach CloudCLI's ports with Windows Firewall (asks for admin once, via UAC).
# Reads the port(s) and the allowed networks (firewallAllow) from the config; run it again
# after changing either. -Remove deletes the rules for the port(s); -DryRun only prints them.
#
# Why a Block rule: the "Node.js JavaScript Runtime" rules Windows creates on first run allow
# node.exe inbound on ALL ports from ANY address. A Block rule overrides Allow rules, so this
# blocks the port for every IPv4 source outside the allowed networks.
[CmdletBinding()]
param(
    [int[]]$Port = @(),
    [string[]]$Allow = @(),
    [switch]$Remove,
    [switch]$DryRun,
    [string]$Config = '',
    [string]$LogFile = ''
)

$ErrorActionPreference = 'Continue'
if ($Port.Count -eq 0 -or (-not $Remove -and $Allow.Count -eq 0) -or -not $LogFile) {
    . (Join-Path $PSScriptRoot '_common.ps1')
    $cfg = Read-ServerConfig -Config $Config
    if ($Port.Count -eq 0) {
        $Port = @([int]$cfg.port)
        if ($cfg.stagingPort) { $Port += [int]$cfg.stagingPort }
    }
    if (-not $Remove -and $Allow.Count -eq 0) {
        $Allow = @($cfg.firewallAllow)
        if ($Allow.Count -eq 0) {
            Write-Host "No networks in firewallAllow (listen address: $($cfg.listenAddress)); no firewall rules needed."
            if ($cfg.listenAddress -ne '127.0.0.1') { Write-Host 'Warning: the server listens on the network but no networks are allowed in the config.' }
            exit 0
        }
    }
    if (-not $LogFile) { $LogFile = Join-Path $cfg.paths.logs 'firewall.log' }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $DryRun) {
    $quote = { param($s) "'" + ($s -replace "'", "''") + "'" }
    $inner = "& $(& $quote $PSCommandPath) -Port $($Port -join ',') -LogFile $(& $quote $LogFile)"
    if ($Allow.Count -gt 0) { $inner += ' -Allow ' + (($Allow | ForEach-Object { & $quote $_ }) -join ',') }
    if ($Remove) { $inner += ' -Remove' }
    Write-Host "Asking for administrator rights to change Windows Firewall rules for port(s) $($Port -join ', ') ..."
    try {
        $process = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
            -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command `"$inner`""
    } catch {
        Write-Host 'Firewall not changed: administrator rights were not granted.'
        exit 1
    }
    if (Test-Path -LiteralPath $LogFile) { Get-Content -LiteralPath $LogFile -Tail $Port.Count | ForEach-Object { Write-Host $_ } }
    exit $process.ExitCode
}

function ToUInt([string]$ip) { $b = ([Net.IPAddress]$ip).GetAddressBytes(); [Array]::Reverse($b); [BitConverter]::ToUInt32($b, 0) }
function ToIp([uint32]$n) { $b = [BitConverter]::GetBytes($n); [Array]::Reverse($b); ([Net.IPAddress]$b).ToString() }

$Allow = @($Allow | ForEach-Object { if ($_ -match '/') { $_ } else { "$_/32" } })
# Complement of the allowed networks over the whole IPv4 space -> ranges to block.
$block = @()
if (-not $Remove) {
    $ranges = foreach ($cidr in $Allow) {
        $ip, $bits = $cidr.Split('/'); $bits = [int]$bits
        $size = [uint64][math]::Pow(2, 32 - $bits)
        $start = [uint64](ToUInt $ip) - ([uint64](ToUInt $ip) % $size)
        [pscustomobject]@{ Start = $start; End = $start + $size - 1 }
    }
    $cursor = [uint64]0
    foreach ($r in ($ranges | Sort-Object Start)) {
        if ($r.Start -gt $cursor) { $block += "$(ToIp ([uint32]$cursor))-$(ToIp ([uint32]($r.Start - 1)))" }
        if ($r.End + 1 -gt $cursor) { $cursor = $r.End + 1 }
    }
    if ($cursor -le [uint32]::MaxValue) { $block += "$(ToIp ([uint32]$cursor))-255.255.255.255" }
}

if ($DryRun) {
    foreach ($p in $Port) {
        if ($Remove) { Write-Host "port ${p}: would remove the 'CloudCLI $p - *' rules"; continue }
        Write-Host "port ${p}: would allow [$($Allow -join ', ')] and block [$($block -join ', ')]"
    }
    exit 0
}
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
$failed = $false
foreach ($p in $Port) {
    try {
        # Replace only this port's rules (rules for other ports are left alone).
        Get-NetFirewallRule -Group 'CloudCLI' -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like "CloudCLI $p - *" } | Remove-NetFirewallRule -ErrorAction Stop
        if ($Remove) {
            "$(Get-Date -Format s) OK: port $p rules removed" | Add-Content -LiteralPath $LogFile
            continue
        }
        if ($block.Count -gt 0) {
            New-NetFirewallRule -Group 'CloudCLI' -DisplayName "CloudCLI $p - block others" `
                -Direction Inbound -Action Block -Protocol TCP -LocalPort $p -Profile Any `
                -RemoteAddress $block -ErrorAction Stop | Out-Null
        }
        New-NetFirewallRule -Group 'CloudCLI' -DisplayName "CloudCLI $p - allow $($Allow -join ', ')" `
            -Direction Inbound -Action Allow -Protocol TCP -LocalPort $p -Profile Any `
            -RemoteAddress $Allow -ErrorAction Stop | Out-Null
        "$(Get-Date -Format s) OK: port $p allow=[$($Allow -join ', ')] block=[$($block -join ', ')]" | Add-Content -LiteralPath $LogFile
    } catch {
        $failed = $true
        "$(Get-Date -Format s) ERROR: port ${p}: $_" | Add-Content -LiteralPath $LogFile
    }
}
if ($failed) { exit 1 }
exit 0
