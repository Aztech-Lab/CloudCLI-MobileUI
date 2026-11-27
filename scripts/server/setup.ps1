# [local] Set up CloudCLI-MobileUI on this Windows computer, from a fresh clone:
# checks Node.js and Claude Code, creates the machine config (asks a few questions),
# installs and builds, deploys the runtime, sets the firewall, starts the server in the
# background and makes it start when you log in. Safe to run again (e.g. after git pull).
#
#   .\setup.ps1                     interactive
#   .\setup.ps1 -Yes                no questions: defaults (port 3001, this computer only)
#   .\setup.ps1 -Yes -Port 3001 -Allow 192.168.1.0/24   reachable from that network
#   -NoAutostart  do not start at login     -NoFirewall  leave the firewall alone
#   -NoStart      do not start the server   -SkipBuild   use the existing build in this clone
#   -Config <file>  use a config file somewhere else (default: <clone>\_server\config.json)
[CmdletBinding()]
param(
    [switch]$Yes,
    [switch]$NoAutostart,
    [switch]$NoFirewall,
    [switch]$NoStart,
    [switch]$SkipBuild,
    [int]$Port = 0,
    [string[]]$Allow = @(),
    [string]$Config = ''
)

. (Join-Path $PSScriptRoot '_common.ps1')
function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" }
function Fail([string]$Text) { Write-Host ''; Write-Host "SETUP STOPPED: $Text"; exit 1 }

# --- 1. Prerequisites -------------------------------------------------------------------
Step 'Checking Node.js and Claude Code'
$node = Get-NodeExe
if (-not $node) { Fail 'Node.js is not installed (or not on PATH). Install the current LTS from https://nodejs.org and run setup again.' }
$check = Invoke-ServerCtl @('check-node')
Write-Host $check.Text
if ($check.Code -ne 0) { Fail 'Install a newer Node.js from https://nodejs.org and run setup again.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm was not found next to Node.js.' }

$claudePath = ''
$claude = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($claude) {
    Write-Host "Claude Code: $($claude.Source)"
} else {
    $nativeInstall = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path -LiteralPath $nativeInstall) {
        # Not on PATH: the server needs to be told where it is.
        $claudePath = $nativeInstall
        Write-Host "Claude Code: $nativeInstall (not on PATH; it goes into the config as CLAUDE_CLI_PATH)"
    } else {
        Write-Host 'WARNING: Claude Code was not found. Install it (https://docs.anthropic.com/en/docs/claude-code),'
        Write-Host '         log in once by running "claude", then restart the server. Setup continues.'
    }
}

# --- 2. Machine config --------------------------------------------------------------------
Step 'Machine config'
$configPath = if ($Config) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Config) } elseif ($env:CLOUDCLI_SERVER_CONFIG) { $env:CLOUDCLI_SERVER_CONFIG } else { Join-Path $script:CloneRoot '_server\config.json' }
if (Test-Path -LiteralPath $configPath) {
    Write-Host "Using the existing config: $configPath"
} else {
    if ($Port -le 0) { $Port = 3001 }
    if (-not $Yes -and (Test-Interactive)) {
        $answer = Read-Host "Port for the web UI [$Port]"
        if ($answer -match '^\d+$') { $Port = [int]$answer }
        if ($Allow.Count -eq 0) {
            $hint = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1
            Write-Host 'Phones and tablets reach the server over your network. List the networks allowed to'
            Write-Host 'connect (comma-separated, e.g. 192.168.1.0/24), or leave empty for this computer only.'
            if ($hint) { Write-Host "(This computer is $($hint.IPAddress)/$($hint.PrefixLength).)" }
            $answer = Read-Host 'Allowed networks'
            $Allow = @($answer -split '[,;\s]+' | Where-Object { $_ })
        }
    }
    $listen = if ($Allow.Count -gt 0) { '0.0.0.0' } else { '127.0.0.1' }
    $initArgs = @('init-config', '--config', $configPath, '--port', "$Port", '--listen', $listen)
    if ($Allow.Count -gt 0) { $initArgs += @('--allow', ($Allow -join ',')) }
    if ($claudePath) { $initArgs += @('--claude-path', $claudePath) }
    $result = Invoke-ServerCtl $initArgs
    if ($result.Code -ne 0) { Fail "Could not write the config (see above). Check the port and networks." }
    Write-Host $result.Text
    Write-Host 'Edit it any time (comments explain each setting), then restart.'
}
$cfg = Read-ServerConfig -Config $configPath
$inst = $cfg.instance

# --- 3. Install and build -----------------------------------------------------------------
if (-not $SkipBuild) {
    Step 'Installing dependencies (npm ci) - this takes a few minutes'
    Push-Location -LiteralPath $script:CloneRoot
    & npm ci --no-audit --no-fund
    $code = $LASTEXITCODE
    if ($code -eq 0) {
        Step 'Building (npm run build)'
        & npm run build
        $code = $LASTEXITCODE
    }
    Pop-Location
    if ($code -ne 0) { Fail 'Install or build failed (see above). AGENTS_DEPLOY.md > Troubleshooting covers native module errors.' }
}

# --- 4. Runtime ---------------------------------------------------------------------------
Step "Preparing the runtime in $($inst.runtime)"
& $node $script:ServerCtl deploy --instance live --config $configPath
if ($LASTEXITCODE -ne 0) { Fail "Deploy failed; details in $($inst.deployLog)." }

# --- 5. Firewall --------------------------------------------------------------------------
if ($NoFirewall) {
    Write-Host ''; Write-Host 'Firewall: skipped (-NoFirewall).'
} elseif (@($cfg.firewallAllow).Count -gt 0) {
    Step 'Firewall (Windows asks for administrator rights once)'
    & (Join-Path $PSScriptRoot 'firewall.ps1') -Config $configPath
    if ($LASTEXITCODE -ne 0) { Write-Host 'WARNING: firewall rules were not set. Run firewall.ps1 later; until then Windows decides who can connect.' }
}

# --- 6. Start -----------------------------------------------------------------------------
$owner = Get-PortOwner ([int]$inst.port)
if ($owner.ServerPids.Count -gt 0) {
    Step 'Server'
    Write-Host "A server already runs on port $($inst.port) (PID $($owner.ServerPids -join ', ')). The new build is ready;"
    Write-Host "switch to it with: $(Join-Path $PSScriptRoot 'restart.ps1') -Deploy"
} elseif ($owner.ForeignPids.Count -gt 0) {
    Fail "Port $($inst.port) is used by another program ($($owner.ForeignNames -join ', ')). Change ""port"" in $configPath and run setup again."
} else {
    $result = Invoke-ServerCtl @('activate', '--instance', 'live', '--config', $configPath)
    Write-Host $result.Text
    if ($NoStart) {
        Write-Host ''; Write-Host "Not started (-NoStart). Start it with: $(Join-Path $PSScriptRoot 'start.ps1')"
    } else {
        Step 'Starting the server in the background'
        & (Join-Path $PSScriptRoot 'start.ps1') -Config $configPath
        if ($LASTEXITCODE -ne 0) { Fail "The server did not start; see $($inst.serverLog)." }
    }
}

# --- 7. Autostart -------------------------------------------------------------------------
if ($NoAutostart) {
    Write-Host ''; Write-Host 'Autostart: skipped (-NoAutostart).'
} else {
    Step 'Start at login'
    & (Join-Path $PSScriptRoot 'autostart.ps1') on -Config $configPath
}

# --- Done ---------------------------------------------------------------------------------
Step 'Done'
Write-Host "Open http://127.0.0.1:$($inst.port) on this computer and create your account (the first one is the only one)."
if (@($cfg.firewallAllow).Count -gt 0) {
    Write-Host "Other devices on $(@($cfg.firewallAllow) -join ', ') use http://<this computer's address>:$($inst.port) - create the account first."
}
Write-Host "Manage it with the scripts in $PSScriptRoot (status, restart, stop, autostart), or in Settings > MobileUI > Server."
exit 0
