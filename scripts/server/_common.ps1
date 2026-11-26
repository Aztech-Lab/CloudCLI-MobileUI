# [local] Shared helpers for the Windows scripts in this folder (dot-sourced, Windows PowerShell 5.1+).
# Machine settings come from the config file (see config.template.jsonc), read through
# lib\serverctl.mjs, which the macOS/Linux scripts use too.

# Not 'Stop': in Windows PowerShell any line a native program writes to stderr (warnings
# included) would then abort the script; once that took the live server down mid-cutover.
# Exit codes are checked instead.
$ErrorActionPreference = 'Continue'
$script:ServerCtl = Join-Path $PSScriptRoot 'lib\serverctl.mjs'
$script:CloneRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:StartupApprovedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
# Node prints UTF-8; read it as such (paths may contain non-ASCII characters).
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Get-NodeExe {
    $cmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

# Runs lib\serverctl.mjs; returns @{ Code; Text } (stdout). Its errors go to the console.
function Invoke-ServerCtl([string[]]$Arguments) {
    $node = Get-NodeExe
    if (-not $node) {
        Write-Host 'Node.js was not found on PATH. Install Node.js (see package.json "engines") and try again.'
        exit 1
    }
    $out = & $node $script:ServerCtl @Arguments
    return @{ Code = $LASTEXITCODE; Text = (@($out) -join "`n") }
}

# Windows PowerShell drops empty arguments to native programs, so add optional ones only when set.
# A relative path is resolved against the current PowerShell location (which Node does not see).
function Get-ConfigArgs([string]$Config) {
    if ($Config) { return @('--config', $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Config)) }
    return @()
}

# The resolved config plus .instance (ports, folders and logs of the live server or the test portal).
function Read-ServerConfig([string]$Config, [string]$Instance = 'live', [int]$Port = 0) {
    $arguments = @('config', '--instance', $Instance, '--format', 'json') + (Get-ConfigArgs $Config)
    if ($Port -gt 0) { $arguments += @('--port', "$Port") }
    $result = Invoke-ServerCtl $arguments
    if ($result.Code -ne 0) { exit $result.Code }
    return ($result.Text | ConvertFrom-Json)
}

# /health of the instance: up, version, activeWork, busy. Short timeouts: Invoke-WebRequest
# loops have hung in hidden PowerShell sessions, so this goes through Node.
function Get-ServerHealth($Cfg, [string]$Instance) {
    $arguments = @('health', '--instance', $Instance, '--port', "$($Cfg.instance.port)") + (Get-ConfigArgs $Cfg.configPath)
    $result = Invoke-ServerCtl $arguments
    try { return ($result.Text | ConvertFrom-Json) } catch { return [pscustomobject]@{ up = $false; busy = $false } }
}

# Which processes listen on the port: CloudCLI servers (node ... cli.js start) and anything else.
function Get-PortOwner([int]$Port) {
    $owner = [pscustomobject]@{ ServerPids = @(); ForeignPids = @(); ForeignNames = @() }
    $ids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 })
    foreach ($id in $ids) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine -match 'cli\.js"?\s+start') {
            $owner.ServerPids += [int]$id
        } else {
            $owner.ForeignPids += [int]$id
            $owner.ForeignNames += $(if ($process) { $process.Name } else { '?' })
        }
    }
    return $owner
}

function Test-Interactive {
    if (-not [Environment]::UserInteractive) { return $false }
    if (@([Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-NonI' }).Count -gt 0) { return $false }
    try { if ([Console]::IsInputRedirected) { return $false } } catch { return $false }
    return $true
}

# Before a restart or stop: if work is running, show it and ask (or refuse when nobody can answer).
function Confirm-ActiveWork($Health, [switch]$Force, [string]$Action) {
    if (-not $Health.busy) { return $true }
    $w = $Health.activeWork
    Write-Host "Running work: $($w.turns) turn(s) being written, $($w.backgroundSessions) session(s) with background work, $($w.backgroundTasks) background task(s)."
    Write-Host "A $($Action.ToLower()) ends all of it, and it cannot be resumed."
    if ($Force) { Write-Host '-Force given: continuing anyway.'; return $true }
    if (-not (Test-Interactive)) {
        Write-Host "Not asking (no interactive console). Wait and try again, or add -Force."
        return $false
    }
    $answer = Read-Host "$Action anyway? [y/N]"
    return ($answer -match '^(y|yes)$')
}

# A logger that appends timestamped lines to a file and echoes them.
function New-Logger([string]$File) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $File) | Out-Null
    return {
        param($Message)
        $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
        Add-Content -Encoding utf8 -LiteralPath $File -Value $line
        Write-Host $line
    }.GetNewClosure()
}

# Stops the CloudCLI server on the port, and only that: refuses when another program holds it.
function Stop-CloudCliOnPort([int]$Port, $Log) {
    $owner = Get-PortOwner $Port
    if ($owner.ForeignPids.Count -gt 0) {
        & $Log "ERROR: port $Port is held by PID $($owner.ForeignPids -join ', ') ($($owner.ForeignNames -join ', ')), which is not CloudCLI; not stopping it"
        return $false
    }
    if ($owner.ServerPids.Count -eq 0) {
        & $Log "nothing is listening on port $Port"
        return $true
    }
    foreach ($id in $owner.ServerPids) {
        & $Log "stopping PID $id"
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
    for ($i = 0; $i -lt 30; $i++) {
        if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Seconds 1
    }
    & $Log "ERROR: port $Port is still in use"
    return $false
}

# conhost --headless hosts the console without any window (no flash). Present since Windows 10 1903.
function Get-HiddenLauncher {
    if ([Environment]::OSVersion.Version.Build -ge 18362) { return 'conhost.exe --headless powershell.exe' }
    return 'powershell.exe'
}

function Format-CommandLineArg([string]$Value) {
    if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
    return $Value
}

# The command line that runs one of these scripts hidden.
function Get-HiddenScriptCommand([string]$ScriptPath, [string[]]$ScriptArgs) {
    $line = (Get-HiddenLauncher) + ' -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (Format-CommandLineArg $ScriptPath)
    foreach ($a in $ScriptArgs) { $line += ' ' + (Format-CommandLineArg $a) }
    return $line
}

# Starts a script hidden and fully detached. Win32_Process.Create runs it outside the caller's
# process tree and job, so it survives the caller (e.g. a chat inside the server it restarts).
function Start-DetachedScript([string]$ScriptPath, [string[]]$ScriptArgs) {
    $commandLine = Get-HiddenScriptCommand $ScriptPath $ScriptArgs
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine      = $commandLine
        CurrentDirectory = $script:CloneRoot
    }
    if (-not $result -or $result.ReturnValue -ne 0) {
        Write-Host "Could not start a detached process (Win32_Process.Create returned $($result.ReturnValue))."
        return $null
    }
    return $result.ProcessId
}

# 'on', 'off' or 'disabled' (registered, but switched off in Task Manager > Startup apps).
function Get-AutostartState([string]$Name) {
    $command = (Get-ItemProperty -Path $script:RunKey -Name $Name -ErrorAction SilentlyContinue).$Name
    if (-not $command) { return [pscustomobject]@{ state = 'off'; name = $Name; command = $null } }
    $approved = (Get-ItemProperty -Path $script:StartupApprovedKey -Name $Name -ErrorAction SilentlyContinue).$Name
    # StartupApproved: first byte even = enabled, odd = disabled by the user.
    $state = if ($approved -and $approved.Length -gt 0 -and ($approved[0] -band 1)) { 'disabled' } else { 'on' }
    return [pscustomobject]@{ state = $state; name = $Name; command = $command }
}

# Common switches passed on to another script of this folder.
function Get-PassThroughArgs($Cfg, [switch]$Staging, [switch]$Local) {
    $a = @('-Port', "$($Cfg.instance.port)")
    if ($Staging) { $a += '-Staging' }
    if ($Local) { $a += '-Local' }
    if ($Cfg.configPath) { $a += @('-Config', $Cfg.configPath) }
    return $a
}
