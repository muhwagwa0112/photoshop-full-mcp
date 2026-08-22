[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipCodexRegistration,
    [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'install\Install.ps1'
$projectRoot = Split-Path -Parent $PSScriptRoot
$arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-PackagePath', $projectRoot)
if ($SkipBuild) { $arguments += '-SkipBuild' }
if ($SkipCodexRegistration) { $arguments += '-SkipCodexRegistration' }
if ($InstallRoot) { $arguments += @('-InstallRoot', $InstallRoot) }
& powershell.exe @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
