# [local] Prepare a new build for the server without stopping it.
#
#   .\deploy.ps1                 package this clone (already built) into <runtime>.next
#   .\deploy.ps1 -Build          run `npm run build` first
#   .\deploy.ps1 -Staging -From <worktree> [-Build] [-FreshDb]   build for the test portal
#
# <runtime>.next is what `npm pack` ships plus the production dependencies installed from
# the checkout's package-lock.json, so the server runs exactly the versions the tests ran
# against. It becomes the running build on the next `restart.ps1 -Deploy`.
# -FreshDb makes the test portal take a new copy of the real database on its next start.
[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$Staging,
    [string]$From = '',
    [switch]$FreshDb,
    [string]$Config = ''
)

. (Join-Path $PSScriptRoot '_common.ps1')
$arguments = @('deploy', '--instance', $(if ($Staging) { 'staging' } else { 'live' })) + (Get-ConfigArgs $Config)
if ($From) { $arguments += @('--from', (Resolve-Path -LiteralPath $From).Path) }
if ($Build) { $arguments += '--build' }
if ($FreshDb) { $arguments += '--fresh-db' }
$node = Get-NodeExe
if (-not $node) { Write-Host 'Node.js was not found on PATH.'; exit 1 }
# Not captured, so the progress lines show as they happen.
& $node $script:ServerCtl @arguments
$code = $LASTEXITCODE
if ($code -eq 0) {
    Write-Output "Activate it with: $(Join-Path $PSScriptRoot 'restart.ps1') -Deploy$(if ($Staging) { ' -Staging' })   (add -Detach -Delay 30 when running inside CloudCLI)"
}
exit $code
